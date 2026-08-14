import { LockMode } from '@mikro-orm/core'
import type { EntityManager } from '@mikro-orm/postgresql'
import { CustomerDeal } from '@open-mercato/core/modules/customers/data/entities'
import { Dictionary, DictionaryEntry } from '@open-mercato/core/modules/dictionaries/data/entities'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { enforceCommandOptimisticLockWithGuards } from '@open-mercato/shared/lib/crud/optimistic-lock-command'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import type { AwilixContainer } from 'awilix'
import {
  FinooAffiliate,
  FinooAffiliateTransaction,
  FinooDealAcceptance,
  FinooDealAttribution,
  type FinooAffiliateTransactionStatus,
} from '../data/entities'
import type { FinooAffiliateTransactionAction } from '../data/validators'
import { FINOO_AFFILIATE_TRANSACTION_STATUS_DICTIONARY_KEY } from '../setup'
import { resolveAffiliateCommissionSnapshot } from './commission'
import type { FinooScope } from './service'

export type TransactionCreationResult = {
  transaction: FinooAffiliateTransaction | null
  created: boolean
}

type TransactionCreationOptions = {
  includeDeletedDeal?: boolean
}

const TRANSACTION_DEAL_UNIQUE_CONSTRAINT = 'finoo_affiliate_transactions_scope_deal_unique'

function isTransactionDealUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const databaseError = error as { code?: unknown; constraint?: unknown; message?: unknown }
  return databaseError.code === '23505' && (
    databaseError.constraint === TRANSACTION_DEAL_UNIQUE_CONSTRAINT ||
    (typeof databaseError.message === 'string' && databaseError.message.includes(TRANSACTION_DEAL_UNIQUE_CONSTRAINT))
  )
}

export function resolveTransactionTarget(
  current: FinooAffiliateTransactionStatus,
  action: FinooAffiliateTransactionAction,
): FinooAffiliateTransactionStatus {
  if (current === 'processing' && action === 'accept') return 'approved'
  if (current === 'processing' && action === 'reject') return 'rejected'
  if (current === 'rejected' && action === 'reprocess') return 'processing'
  throw new CrudHttpError(409, {
    error: 'Invalid commission transition',
    code: 'INVALID_COMMISSION_TRANSITION',
  })
}

async function resolveStatusEntry(
  em: EntityManager,
  scope: FinooScope,
  status: FinooAffiliateTransactionStatus,
): Promise<DictionaryEntry> {
  const dictionary = await findOneWithDecryption(
    em,
    Dictionary,
    { ...scope, key: FINOO_AFFILIATE_TRANSACTION_STATUS_DICTIONARY_KEY, isActive: true, deletedAt: null },
    undefined,
    scope,
  )
  if (!dictionary) throw new Error('[internal] Affiliate transaction status dictionary was not found')
  const entry = await findOneWithDecryption(
    em,
    DictionaryEntry,
    { ...scope, dictionary: dictionary.id, normalizedValue: status },
    undefined,
    scope,
  )
  if (!entry) throw new Error(`[internal] Affiliate transaction status entry ${status} was not found`)
  return entry
}

async function loadExistingTransaction(
  em: EntityManager,
  dealId: string,
  scope: FinooScope,
): Promise<FinooAffiliateTransaction | null> {
  return findOneWithDecryption(
    em,
    FinooAffiliateTransaction,
    { dealId, ...scope },
    undefined,
    scope,
  )
}

export async function createAffiliateTransactionForDeal(
  em: EntityManager,
  dealId: string,
  scope: FinooScope,
  options: TransactionCreationOptions = {},
): Promise<TransactionCreationResult> {
  const existing = await loadExistingTransaction(em, dealId, scope)
  if (existing) return { transaction: existing, created: false }

  try {
    return await em.transactional(async (transactionalEm) => {
      const concurrent = await loadExistingTransaction(transactionalEm, dealId, scope)
      if (concurrent) return { transaction: concurrent, created: false }
      const [acceptance, attribution, deal] = await Promise.all([
        findOneWithDecryption(
          transactionalEm,
          FinooDealAcceptance,
          { dealId, ...scope },
          undefined,
          scope,
        ),
        findOneWithDecryption(
          transactionalEm,
          FinooDealAttribution,
          { dealId, ...scope, deletedAt: null },
          undefined,
          scope,
        ),
        findOneWithDecryption(
          transactionalEm,
          CustomerDeal,
          { id: dealId, ...scope, ...(options.includeDeletedDeal ? {} : { deletedAt: null }) },
          undefined,
          scope,
        ),
      ])
      if (!acceptance || !attribution || !deal) return { transaction: null, created: false }

      const affiliate = attribution.affiliateId
        ? await findOneWithDecryption(
            transactionalEm,
            FinooAffiliate,
            { id: attribution.affiliateId, customerUserId: attribution.affiliateUserId, ...scope, isActive: true, deletedAt: null },
            { lockMode: LockMode.PESSIMISTIC_WRITE },
            scope,
          )
        : await findOneWithDecryption(
            transactionalEm,
            FinooAffiliate,
            { customerUserId: attribution.affiliateUserId, ...scope, isActive: true, deletedAt: null },
            { lockMode: LockMode.PESSIMISTIC_WRITE },
            scope,
          )
      if (!affiliate) return { transaction: null, created: false }
      if (!attribution.affiliateId) attribution.affiliateId = affiliate.id

      const commission = resolveAffiliateCommissionSnapshot({
        commissionMode: affiliate.commissionMode ?? null,
        commissionRateBps: affiliate.commissionRateBps ?? null,
        commissionFixedAmount: affiliate.commissionFixedAmount ?? null,
        attributionCommissionAmount: attribution.commissionAmount,
        dealValueAmount: acceptance.dealValueAmount ?? null,
        dealValueCurrency: acceptance.dealValueCurrency ?? null,
      })

      const processing = await resolveStatusEntry(transactionalEm, scope, 'processing')
      const transaction = transactionalEm.create(FinooAffiliateTransaction, {
        ...scope,
        affiliateId: affiliate.id,
        affiliateUserId: affiliate.customerUserId ?? attribution.affiliateUserId,
        dealId,
        dealName: deal.title.trim().slice(0, 300) || null,
        dealCompany: attribution.companyName ?? null,
        ...commission,
        currency: 'PLN',
        commissionStatusEntryId: processing.id,
        commissionStatus: 'processing',
        acceptedAt: acceptance.acceptedAt,
      })
      transactionalEm.persist(transaction)
      await transactionalEm.flush()
      return { transaction, created: true }
    })
  } catch (error) {
    if (!isTransactionDealUniqueViolation(error)) throw error
    const winner = await loadExistingTransaction(em.fork(), dealId, scope)
    if (winner) return { transaction: winner, created: false }
    throw error
  }
}

export async function transitionAffiliateTransaction(
  em: EntityManager,
  container: AwilixContainer,
  input: { id: string; action: FinooAffiliateTransactionAction; updatedAt: string },
  scope: FinooScope,
): Promise<{ transaction: FinooAffiliateTransaction; previousStatus: FinooAffiliateTransactionStatus }> {
  return em.transactional(async (transactionalEm) => {
    const transaction = await findOneWithDecryption(
      transactionalEm,
      FinooAffiliateTransaction,
      { id: input.id, ...scope },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
      scope,
    )
    if (!transaction) throw new CrudHttpError(404, { error: 'Not found' })
    await enforceCommandOptimisticLockWithGuards(container, {
      resourceKind: 'finoo_affiliates.affiliate_transaction',
      resourceId: transaction.id,
      current: transaction.updatedAt,
      expected: input.updatedAt,
    })
    const previousStatus = transaction.commissionStatus
    const target = resolveTransactionTarget(previousStatus, input.action)
    const statusEntry = await resolveStatusEntry(transactionalEm, scope, target)
    transaction.commissionStatus = target
    transaction.commissionStatusEntryId = statusEntry.id
    await transactionalEm.flush()
    return { transaction, previousStatus }
  })
}

export async function undoAffiliateTransactionTransition(
  em: EntityManager,
  input: {
    id: string
    scope: FinooScope
    beforeStatus: FinooAffiliateTransactionStatus
    afterStatus: FinooAffiliateTransactionStatus
    afterUpdatedAt: string
  },
): Promise<FinooAffiliateTransaction> {
  return em.transactional(async (transactionalEm) => {
    const transaction = await findOneWithDecryption(
      transactionalEm,
      FinooAffiliateTransaction,
      { id: input.id, ...input.scope },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
      input.scope,
    )
    if (!transaction) throw new CrudHttpError(404, { error: 'Not found' })
    if (
      transaction.commissionStatus === 'paid_out' ||
      input.beforeStatus === 'paid_out' ||
      transaction.commissionStatus !== input.afterStatus ||
      transaction.updatedAt.toISOString() !== input.afterUpdatedAt
    ) {
      throw new CrudHttpError(409, {
        error: 'Transaction changed after the original transition',
        code: 'AFFILIATE_TRANSACTION_UNDO_CONFLICT',
      })
    }
    const statusEntry = await resolveStatusEntry(transactionalEm, input.scope, input.beforeStatus)
    transaction.commissionStatus = input.beforeStatus
    transaction.commissionStatusEntryId = statusEntry.id
    await transactionalEm.flush()
    return transaction
  })
}
