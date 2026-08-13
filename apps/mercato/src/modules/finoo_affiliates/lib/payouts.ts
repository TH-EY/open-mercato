import { createHash, randomBytes } from 'node:crypto'
import { LockMode } from '@mikro-orm/core'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { AwilixContainer } from 'awilix'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { enforceCommandOptimisticLockWithGuards } from '@open-mercato/shared/lib/crud/optimistic-lock-command'
import { hashForLookup } from '@open-mercato/shared/lib/encryption/aes'
import { findOneWithDecryption, findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { Dictionary, DictionaryEntry } from '@open-mercato/core/modules/dictionaries/data/entities'
import {
  FinooAffiliate,
  FinooAffiliatePayout,
  FinooAffiliateTransaction,
  FinooPayoutPreview,
  type FinooPayoutSelectionItem,
} from '../data/entities'
import { FINOO_AFFILIATE_TRANSACTION_STATUS_DICTIONARY_KEY } from '../setup'
import type { FinooScope } from './service'

const PREVIEW_LIFETIME_MS = 15 * 60 * 1000
const REFERENCE_LOCK = 'finoo_affiliates:payout-reference'
export const FINOO_PAYOUT_PREVIEW_PRUNE_QUEUE = 'finoo-affiliates-payout-preview-prune'

export type PayoutPreviewResult = {
  paymentReference: string
  affiliateId: string
  affiliateEmail: string
  affiliateUpdatedAt: string
  accountHolderName: string
  accountNumber: string
  amount: string
  currency: 'PLN'
  selectedCount: number
  transactions: FinooPayoutSelectionItem[]
  expiresAt: string
}

function canonicalSelection(selection: FinooPayoutSelectionItem[]): FinooPayoutSelectionItem[] {
  return [...selection].sort((left, right) => left.id.localeCompare(right.id))
}

type BankProfile = Pick<FinooAffiliate, 'accountHolderName' | 'accountNumber'>

function bankProfileHash(profile: BankProfile, scope: FinooScope): string {
  const hash = hashForLookup(
    JSON.stringify([profile.accountHolderName ?? '', profile.accountNumber ?? '']),
    `finoo_affiliates:payout-profile:${scope.tenantId}:${scope.organizationId}`,
  )
  if (!hash.startsWith('v2:')) {
    throw new Error('[internal] Affiliate payout bindings require a configured lookup-hash pepper')
  }
  return hash
}

export function buildPayoutBinding(input: {
  selection: FinooPayoutSelectionItem[]
  affiliateId: string
  affiliateUpdatedAt: string
  amount: string
  currency: string
  profileHash: string
}): string {
  return createHash('sha256').update(JSON.stringify({
    selection: canonicalSelection(input.selection),
    affiliateId: input.affiliateId,
    affiliateUpdatedAt: input.affiliateUpdatedAt,
    amount: input.amount,
    currency: input.currency,
    profileHash: input.profileHash,
  })).digest('hex')
}

function assertExactSelection(actual: FinooPayoutSelectionItem[], expected: FinooPayoutSelectionItem[]): void {
  if (JSON.stringify(canonicalSelection(actual)) !== JSON.stringify(canonicalSelection(expected))) {
    throw new CrudHttpError(409, { error: 'PAYOUT_PREVIEW_STALE' })
  }
}

function assertExactCompletedPayoutRetry(
  preview: FinooPayoutPreview,
  payout: FinooAffiliatePayout,
  input: { affiliateUpdatedAt: string; transactions: FinooPayoutSelectionItem[] },
  scope: FinooScope,
): void {
  assertExactSelection(preview.selection, input.transactions)
  const binding = buildPayoutBinding({
    selection: input.transactions,
    affiliateId: payout.affiliateId,
    affiliateUpdatedAt: input.affiliateUpdatedAt,
    amount: String(payout.amount),
    currency: payout.currency,
    profileHash: bankProfileHash(payout, scope),
  })
  if (binding !== preview.bindingHash) throw new CrudHttpError(409, { error: 'PAYOUT_PREVIEW_STALE' })
}

async function createPaymentReference(em: EntityManager): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const reference = `FINOO-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${randomBytes(8).toString('hex').toUpperCase()}`
    const [preview, payout] = await Promise.all([
      findOneWithDecryption(em, FinooPayoutPreview, { paymentReference: reference }, undefined, {}),
      findOneWithDecryption(em, FinooAffiliatePayout, { paymentReference: reference }, undefined, {}),
    ])
    if (!preview && !payout) return reference
  }
  throw new CrudHttpError(409, { error: 'PAYOUT_REFERENCE_RESERVATION_FAILED' })
}

function validateEligibleTransactions(transactions: FinooAffiliateTransaction[], count: number): FinooAffiliateTransaction {
  if (transactions.length !== count) throw new CrudHttpError(404, { error: 'TRANSACTION_NOT_FOUND' })
  const affiliateId = transactions[0]?.affiliateId
  if (!affiliateId || transactions.some((transaction) => transaction.affiliateId !== affiliateId)) {
    throw new CrudHttpError(409, { error: 'MIXED_AFFILIATES' })
  }
  if (transactions.some((transaction) => transaction.commissionStatus !== 'approved' || transaction.payoutId)) {
    throw new CrudHttpError(409, { error: 'TRANSACTION_NOT_APPROVED' })
  }
  if (transactions.some((transaction) => transaction.currency !== 'PLN')) {
    throw new CrudHttpError(409, { error: 'PAYOUT_CURRENCY_MISMATCH' })
  }
  return transactions[0]
}

export async function createPayoutPreview(
  em: EntityManager,
  selection: FinooPayoutSelectionItem[],
  scope: FinooScope,
  now = new Date(),
): Promise<PayoutPreviewResult> {
  const canonical = canonicalSelection(selection)
  return em.transactional(async (transactionalEm) => {
    await transactionalEm.getConnection().execute(
      'select pg_advisory_xact_lock(hashtextextended(?, 0))',
      [REFERENCE_LOCK],
    )
    const transactions = await findWithDecryption(
      transactionalEm,
      FinooAffiliateTransaction,
      { ...scope, id: { $in: canonical.map((item) => item.id) } },
      { lockMode: LockMode.PESSIMISTIC_WRITE, orderBy: { id: 'ASC' } },
      scope,
    )
    const first = validateEligibleTransactions(transactions, canonical.length)
    assertExactSelection(
      transactions.map((transaction) => ({ id: transaction.id, updatedAt: transaction.updatedAt.toISOString() })),
      canonical,
    )
    const affiliate = await findOneWithDecryption(
      transactionalEm,
      FinooAffiliate,
      { ...scope, id: first.affiliateId, isActive: true, deletedAt: null },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
      scope,
    )
    if (!affiliate) throw new CrudHttpError(404, { error: 'AFFILIATE_NOT_FOUND' })
    if (!affiliate.accountHolderName?.trim() || !affiliate.accountNumber?.trim()) {
      throw new CrudHttpError(409, { error: 'PROFILE_INCOMPLETE' })
    }
    const amount = transactions.reduce((total, transaction) => total + BigInt(transaction.commissionAmount), 0n).toString(10)
    const affiliateUpdatedAt = affiliate.updatedAt.toISOString()
    const bindingHash = buildPayoutBinding({
      selection: canonical,
      affiliateId: affiliate.id,
      affiliateUpdatedAt,
      amount,
      currency: 'PLN',
      profileHash: bankProfileHash(affiliate, scope),
    })
    const preview = transactionalEm.create(FinooPayoutPreview, {
      ...scope,
      paymentReference: await createPaymentReference(transactionalEm),
      affiliateId: affiliate.id,
      bindingHash,
      selection: canonical,
      amount,
      currency: 'PLN',
      expiresAt: new Date(now.getTime() + PREVIEW_LIFETIME_MS),
    })
    transactionalEm.persist(preview)
    await transactionalEm.flush()
    return {
      paymentReference: preview.paymentReference,
      affiliateId: affiliate.id,
      affiliateEmail: affiliate.email,
      affiliateUpdatedAt,
      accountHolderName: affiliate.accountHolderName,
      accountNumber: affiliate.accountNumber,
      amount,
      currency: 'PLN',
      selectedCount: canonical.length,
      transactions: canonical,
      expiresAt: preview.expiresAt.toISOString(),
    }
  })
}

export async function validatePayoutConfirmation(
  em: EntityManager,
  input: { paymentReference: string; affiliateUpdatedAt: string; transactions: FinooPayoutSelectionItem[] },
  scope: FinooScope,
  now = new Date(),
): Promise<{ preview: FinooPayoutPreview; payout: FinooAffiliatePayout | null }> {
  const preview = await findOneWithDecryption(em, FinooPayoutPreview, { ...scope, paymentReference: input.paymentReference }, undefined, scope)
  if (!preview) throw new CrudHttpError(409, { error: 'PAYOUT_PREVIEW_STALE' })
  if (preview.payoutId) {
    const payout = await findOneWithDecryption(em, FinooAffiliatePayout, { ...scope, id: preview.payoutId }, undefined, scope)
    if (!payout) throw new Error('[internal] Payout preview points to a missing payout')
    assertExactCompletedPayoutRetry(preview, payout, input, scope)
    return { preview, payout }
  }
  if (preview.expiresAt <= now) throw new CrudHttpError(409, { error: 'PAYOUT_PREVIEW_STALE' })
  assertExactSelection(preview.selection, input.transactions)
  const affiliate = await findOneWithDecryption(em, FinooAffiliate, { ...scope, id: preview.affiliateId, deletedAt: null }, undefined, scope)
  if (!affiliate || affiliate.updatedAt.toISOString() !== input.affiliateUpdatedAt) {
    throw new CrudHttpError(409, { error: 'PAYOUT_PREVIEW_STALE' })
  }
  const binding = buildPayoutBinding({
    selection: input.transactions,
    affiliateId: affiliate.id,
    affiliateUpdatedAt: input.affiliateUpdatedAt,
    amount: String(preview.amount),
    currency: preview.currency,
    profileHash: bankProfileHash(affiliate, scope),
  })
  if (binding !== preview.bindingHash) throw new CrudHttpError(409, { error: 'PAYOUT_PREVIEW_STALE' })
  return { preview, payout: null }
}

async function loadPaidOutStatusEntry(em: EntityManager, scope: FinooScope): Promise<DictionaryEntry> {
  const dictionary = await findOneWithDecryption(
    em,
    Dictionary,
    { ...scope, key: FINOO_AFFILIATE_TRANSACTION_STATUS_DICTIONARY_KEY, isActive: true, deletedAt: null },
    undefined,
    scope,
  )
  if (!dictionary) throw new Error('[internal] Affiliate transaction status dictionary not found')
  const entry = await findOneWithDecryption(
    em,
    DictionaryEntry,
    { ...scope, dictionary: dictionary.id, normalizedValue: 'paid_out' },
    undefined,
    scope,
  )
  if (!entry) throw new Error('[internal] Paid-out status entry not found')
  return entry
}

export async function createAffiliatePayout(
  em: EntityManager,
  container: AwilixContainer,
  input: { paymentReference: string; affiliateUpdatedAt: string; transactions: FinooPayoutSelectionItem[] },
  scope: FinooScope,
  now = new Date(),
): Promise<{ payout: FinooAffiliatePayout; created: boolean; transactionIds: string[] }> {
  return em.transactional(async (transactionalEm) => {
    const preview = await findOneWithDecryption(
      transactionalEm,
      FinooPayoutPreview,
      { ...scope, paymentReference: input.paymentReference },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
      scope,
    )
    if (!preview) throw new CrudHttpError(409, { error: 'PAYOUT_PREVIEW_STALE' })
    if (preview.payoutId) {
      const existing = await findOneWithDecryption(transactionalEm, FinooAffiliatePayout, { ...scope, id: preview.payoutId }, undefined, scope)
      if (!existing) throw new Error('[internal] Payout preview points to a missing payout')
      assertExactCompletedPayoutRetry(preview, existing, input, scope)
      return { payout: existing, created: false, transactionIds: preview.selection.map((item) => item.id) }
    }
    if (preview.expiresAt <= now) throw new CrudHttpError(409, { error: 'PAYOUT_PREVIEW_STALE' })
    assertExactSelection(preview.selection, input.transactions)
    const affiliate = await findOneWithDecryption(
      transactionalEm,
      FinooAffiliate,
      { ...scope, id: preview.affiliateId, isActive: true, deletedAt: null },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
      scope,
    )
    if (!affiliate || affiliate.updatedAt.toISOString() !== input.affiliateUpdatedAt || !affiliate.accountHolderName || !affiliate.accountNumber) {
      throw new CrudHttpError(409, { error: 'PAYOUT_PREVIEW_STALE' })
    }
    const canonical = canonicalSelection(input.transactions)
    const transactions = await findWithDecryption(
      transactionalEm,
      FinooAffiliateTransaction,
      { ...scope, id: { $in: canonical.map((item) => item.id) } },
      { lockMode: LockMode.PESSIMISTIC_WRITE, orderBy: { id: 'ASC' } },
      scope,
    )
    validateEligibleTransactions(transactions, canonical.length)
    assertExactSelection(transactions.map((transaction) => ({ id: transaction.id, updatedAt: transaction.updatedAt.toISOString() })), canonical)
    if (transactions.some((transaction) => transaction.affiliateId !== affiliate.id)) {
      throw new CrudHttpError(409, { error: 'PAYOUT_PREVIEW_STALE' })
    }
    for (const transaction of transactions) {
      const expected = canonical.find((item) => item.id === transaction.id)?.updatedAt
      await enforceCommandOptimisticLockWithGuards(container, {
        resourceKind: 'finoo_affiliates.affiliate_transaction',
        resourceId: transaction.id,
        current: transaction.updatedAt,
        expected,
      })
    }
    await enforceCommandOptimisticLockWithGuards(container, {
      resourceKind: 'finoo_affiliates.affiliate',
      resourceId: affiliate.id,
      current: affiliate.updatedAt,
      expected: input.affiliateUpdatedAt,
    })
    const amount = transactions.reduce((total, transaction) => total + BigInt(transaction.commissionAmount), 0n).toString(10)
    const binding = buildPayoutBinding({
      selection: canonical,
      affiliateId: affiliate.id,
      affiliateUpdatedAt: input.affiliateUpdatedAt,
      amount,
      currency: 'PLN',
      profileHash: bankProfileHash(affiliate, scope),
    })
    if (binding !== preview.bindingHash || amount !== String(preview.amount) || preview.currency !== 'PLN') {
      throw new CrudHttpError(409, { error: 'PAYOUT_PREVIEW_STALE' })
    }
    if (!affiliate.customerUserId) throw new CrudHttpError(409, { error: 'PAYOUT_PREVIEW_STALE' })
    const paidOut = await loadPaidOutStatusEntry(transactionalEm, scope)
    const payout = transactionalEm.create(FinooAffiliatePayout, {
      ...scope,
      affiliateId: affiliate.id,
      affiliateUserId: affiliate.customerUserId,
      paymentReference: preview.paymentReference,
      amount,
      currency: 'PLN',
      accountHolderName: affiliate.accountHolderName,
      accountNumber: affiliate.accountNumber,
      paidAt: now,
    })
    transactionalEm.persist(payout)
    await transactionalEm.flush()
    for (const transaction of transactions) {
      transaction.payoutId = payout.id
      transaction.commissionStatus = 'paid_out'
      transaction.commissionStatusEntryId = paidOut.id
    }
    preview.payoutId = payout.id
    await transactionalEm.flush()
    return { payout, created: true, transactionIds: transactions.map((transaction) => transaction.id) }
  })
}

export async function pruneExpiredPayoutPreviews(em: EntityManager, scope: FinooScope, now = new Date(), limit = 250): Promise<number> {
  const rows = await em.getConnection().execute<Array<{ id: string }>>(
    `select id from finoo_payout_previews
      where tenant_id = ? and organization_id = ? and payout_id is null and expires_at < ?
      order by expires_at asc limit ?`,
    [scope.tenantId, scope.organizationId, now, limit],
  )
  if (rows.length === 0) return 0
  return em.nativeDelete(FinooPayoutPreview, { ...scope, id: { $in: rows.map((row) => row.id) }, payoutId: null })
}
