import { createHash, randomBytes, randomUUID } from 'node:crypto'
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
import type { FinooPayoutConfirmGroupInput } from '../data/validators'
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

export type PayoutBatchPreviewResult = {
  batchId: string
  groups: PayoutPreviewResult[]
  selectedCount: number
  affiliateCount: number
  totalAmount: string
  currency: 'PLN'
} & Partial<PayoutPreviewResult>

export type PayoutBatchCreationResult = {
  payouts: Array<{
    payout: FinooAffiliatePayout
    created: boolean
    transactionIds: string[]
  }>
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

export function buildPayoutBatchBinding(input: {
  batchId: string
  scope: FinooScope
  groups: Array<{ paymentReference: string; bindingHash: string }>
}): string {
  return createHash('sha256').update(JSON.stringify({
    batchId: input.batchId,
    tenantId: input.scope.tenantId,
    organizationId: input.scope.organizationId,
    groups: [...input.groups].sort((left, right) => left.paymentReference.localeCompare(right.paymentReference)),
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

function validateEligibleTransactions(transactions: FinooAffiliateTransaction[], count: number): void {
  if (transactions.length !== count) throw new CrudHttpError(404, { error: 'TRANSACTION_NOT_FOUND' })
  if (transactions.some((transaction) => transaction.commissionStatus !== 'approved' || transaction.payoutId)) {
    throw new CrudHttpError(409, { error: 'TRANSACTION_NOT_APPROVED' })
  }
  if (transactions.some((transaction) => transaction.currency !== 'PLN')) {
    throw new CrudHttpError(409, { error: 'PAYOUT_CURRENCY_MISMATCH' })
  }
}

function groupTransactionsByAffiliate(
  transactions: FinooAffiliateTransaction[],
): Map<string, FinooAffiliateTransaction[]> {
  const groups = new Map<string, FinooAffiliateTransaction[]>()
  for (const transaction of transactions) {
    const current = groups.get(transaction.affiliateId) ?? []
    current.push(transaction)
    groups.set(transaction.affiliateId, current)
  }
  return new Map([...groups.entries()].sort(([left], [right]) => left.localeCompare(right)))
}

export async function createPayoutPreview(
  em: EntityManager,
  selection: FinooPayoutSelectionItem[],
  scope: FinooScope,
  now = new Date(),
): Promise<PayoutBatchPreviewResult> {
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
    validateEligibleTransactions(transactions, canonical.length)
    assertExactSelection(
      transactions.map((transaction) => ({ id: transaction.id, updatedAt: transaction.updatedAt.toISOString() })),
      canonical,
    )
    const transactionGroups = groupTransactionsByAffiliate(transactions)
    const affiliates = await findWithDecryption(
      transactionalEm,
      FinooAffiliate,
      { ...scope, id: { $in: [...transactionGroups.keys()] }, isActive: true, deletedAt: null },
      { lockMode: LockMode.PESSIMISTIC_WRITE, orderBy: { id: 'ASC' } },
      scope,
    )
    if (affiliates.length !== transactionGroups.size) {
      throw new CrudHttpError(404, { error: 'AFFILIATE_NOT_FOUND' })
    }
    const incomplete = affiliates.flatMap((affiliate) => {
      const missingFields: Array<'accountHolderName' | 'accountNumber'> = []
      if (!affiliate.accountHolderName?.trim()) missingFields.push('accountHolderName')
      if (!affiliate.accountNumber?.trim()) missingFields.push('accountNumber')
      return missingFields.length > 0
        ? [{ affiliateId: affiliate.id, affiliateEmail: affiliate.email, missingFields }]
        : []
    })
    if (incomplete.length > 0) {
      throw new CrudHttpError(409, { error: 'PAYOUT_PROFILES_INCOMPLETE', affiliates: incomplete })
    }
    const batchId = randomUUID()
    const groups: PayoutPreviewResult[] = []
    const previews: FinooPayoutPreview[] = []
    for (const affiliate of affiliates) {
      const affiliateTransactions = transactionGroups.get(affiliate.id)
      if (!affiliateTransactions || !affiliate.accountHolderName || !affiliate.accountNumber) {
        throw new Error('[internal] Valid payout preview group is incomplete')
      }
      const groupSelection = affiliateTransactions.map((transaction) => ({
        id: transaction.id,
        updatedAt: transaction.updatedAt.toISOString(),
      }))
      const amount = affiliateTransactions
        .reduce((total, transaction) => total + BigInt(transaction.commissionAmount), 0n)
        .toString(10)
      const affiliateUpdatedAt = affiliate.updatedAt.toISOString()
      const preview = transactionalEm.create(FinooPayoutPreview, {
        ...scope,
        batchId,
        paymentReference: await createPaymentReference(transactionalEm),
        affiliateId: affiliate.id,
        bindingHash: buildPayoutBinding({
          selection: groupSelection,
          affiliateId: affiliate.id,
          affiliateUpdatedAt,
          amount,
          currency: 'PLN',
          profileHash: bankProfileHash(affiliate, scope),
        }),
        selection: groupSelection,
        amount,
        currency: 'PLN',
        expiresAt: new Date(now.getTime() + PREVIEW_LIFETIME_MS),
      })
      transactionalEm.persist(preview)
      previews.push(preview)
      groups.push({
        paymentReference: preview.paymentReference,
        affiliateId: affiliate.id,
        affiliateEmail: affiliate.email,
        affiliateUpdatedAt,
        accountHolderName: affiliate.accountHolderName,
        accountNumber: affiliate.accountNumber,
        amount,
        currency: 'PLN',
        selectedCount: groupSelection.length,
        transactions: groupSelection,
        expiresAt: preview.expiresAt.toISOString(),
      })
    }
    const batchBindingHash = buildPayoutBatchBinding({
      batchId,
      scope,
      groups: previews.map((preview) => ({
        paymentReference: preview.paymentReference,
        bindingHash: preview.bindingHash,
      })),
    })
    for (const preview of previews) preview.batchBindingHash = batchBindingHash
    await transactionalEm.flush()
    const result: PayoutBatchPreviewResult = {
      batchId,
      groups,
      selectedCount: canonical.length,
      affiliateCount: groups.length,
      totalAmount: groups.reduce((total, group) => total + BigInt(group.amount), 0n).toString(10),
      currency: 'PLN',
    }
    return groups.length === 1 ? { ...result, ...groups[0] } : result
  })
}

async function assertExactPayoutBatch(
  em: EntityManager,
  groups: FinooPayoutConfirmGroupInput[],
  batchId: string | null,
  scope: FinooScope,
  lock: boolean,
): Promise<FinooPayoutConfirmGroupInput[]> {
  const transactionCount = groups.reduce((total, group) => total + group.transactions.length, 0)
  if (groups.length === 0 || transactionCount === 0 || transactionCount > 100) {
    throw new CrudHttpError(409, { error: 'PAYOUT_PREVIEW_STALE' })
  }
  const references = groups.map((group) => group.paymentReference).sort()
  const submittedWhere = { ...scope, paymentReference: { $in: references } }
  const submittedPreviews = lock
    ? await findWithDecryption(
        em,
        FinooPayoutPreview,
        submittedWhere,
        { lockMode: LockMode.PESSIMISTIC_WRITE, orderBy: { paymentReference: 'ASC' } },
        scope,
      )
    : await findWithDecryption(
        em,
        FinooPayoutPreview,
        submittedWhere,
        { orderBy: { paymentReference: 'ASC' } },
        scope,
      )
  if (submittedPreviews.length !== groups.length) {
    throw new CrudHttpError(409, { error: 'PAYOUT_PREVIEW_STALE' })
  }
  if (new Set(submittedPreviews.map((preview) => preview.affiliateId)).size !== submittedPreviews.length) {
    throw new CrudHttpError(409, { error: 'PAYOUT_PREVIEW_STALE' })
  }

  const storedBatchId = batchId ?? (groups.length === 1 ? submittedPreviews[0]?.batchId ?? null : null)
  if (!storedBatchId) {
    if (groups.length !== 1 || submittedPreviews[0]?.batchId || submittedPreviews[0]?.batchBindingHash) {
      throw new CrudHttpError(409, { error: 'PAYOUT_PREVIEW_STALE' })
    }
  } else {
    if (batchId && submittedPreviews.some((preview) => preview.batchId !== batchId)) {
      throw new CrudHttpError(409, { error: 'PAYOUT_PREVIEW_STALE' })
    }
    const batchWhere = { ...scope, batchId: storedBatchId }
    const batchPreviews = lock
      ? await findWithDecryption(
          em,
          FinooPayoutPreview,
          batchWhere,
          { lockMode: LockMode.PESSIMISTIC_WRITE, orderBy: { paymentReference: 'ASC' } },
          scope,
        )
      : await findWithDecryption(
          em,
          FinooPayoutPreview,
          batchWhere,
          { orderBy: { paymentReference: 'ASC' } },
          scope,
        )
    if (
      batchPreviews.length !== submittedPreviews.length
      || JSON.stringify(batchPreviews.map((preview) => preview.paymentReference).sort()) !== JSON.stringify(references)
    ) {
      throw new CrudHttpError(409, { error: 'PAYOUT_PREVIEW_STALE' })
    }
    const binding = buildPayoutBatchBinding({
      batchId: storedBatchId,
      scope,
      groups: batchPreviews.map((preview) => ({
        paymentReference: preview.paymentReference,
        bindingHash: preview.bindingHash,
      })),
    })
    if (batchPreviews.some((preview) => preview.batchBindingHash !== binding)) {
      throw new CrudHttpError(409, { error: 'PAYOUT_PREVIEW_STALE' })
    }
  }

  const completedCount = submittedPreviews.filter((preview) => preview.payoutId).length
  if (completedCount > 0 && completedCount !== submittedPreviews.length) {
    throw new CrudHttpError(409, { error: 'PAYOUT_PREVIEW_STALE' })
  }
  const groupByReference = new Map(groups.map((group) => [group.paymentReference, group]))
  return [...submittedPreviews]
    .sort((left, right) => left.affiliateId.localeCompare(right.affiliateId) || left.paymentReference.localeCompare(right.paymentReference))
    .map((preview) => {
      const group = groupByReference.get(preview.paymentReference)
      if (!group) throw new CrudHttpError(409, { error: 'PAYOUT_PREVIEW_STALE' })
      return group
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

async function createAffiliatePayoutInTransaction(
  em: EntityManager,
  container: AwilixContainer,
  input: FinooPayoutConfirmGroupInput,
  scope: FinooScope,
  paidOut: DictionaryEntry,
  now: Date,
): Promise<{ payout: FinooAffiliatePayout; created: boolean; transactionIds: string[] }> {
  const preview = await findOneWithDecryption(
    em,
    FinooPayoutPreview,
    { ...scope, paymentReference: input.paymentReference },
    { lockMode: LockMode.PESSIMISTIC_WRITE },
    scope,
  )
  if (!preview) throw new CrudHttpError(409, { error: 'PAYOUT_PREVIEW_STALE' })
  if (preview.payoutId) {
    const existing = await findOneWithDecryption(em, FinooAffiliatePayout, { ...scope, id: preview.payoutId }, undefined, scope)
    if (!existing) throw new Error('[internal] Payout preview points to a missing payout')
    assertExactCompletedPayoutRetry(preview, existing, input, scope)
    return { payout: existing, created: false, transactionIds: preview.selection.map((item) => item.id) }
  }
  if (preview.expiresAt <= now) throw new CrudHttpError(409, { error: 'PAYOUT_PREVIEW_STALE' })
  assertExactSelection(preview.selection, input.transactions)
  const affiliate = await findOneWithDecryption(
    em,
    FinooAffiliate,
    { ...scope, id: preview.affiliateId, isActive: true, deletedAt: null },
    { lockMode: LockMode.PESSIMISTIC_WRITE },
    scope,
  )
  if (!affiliate || affiliate.updatedAt.toISOString() !== input.affiliateUpdatedAt || !affiliate.accountHolderName?.trim() || !affiliate.accountNumber?.trim()) {
    throw new CrudHttpError(409, { error: 'PAYOUT_PREVIEW_STALE' })
  }
  const canonical = canonicalSelection(input.transactions)
  const transactions = await findWithDecryption(
    em,
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
  const payout = em.create(FinooAffiliatePayout, {
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
  em.persist(payout)
  await em.flush()
  for (const transaction of transactions) {
    transaction.payoutId = payout.id
    transaction.commissionStatus = 'paid_out'
    transaction.commissionStatusEntryId = paidOut.id
  }
  preview.payoutId = payout.id
  await em.flush()
  return { payout, created: true, transactionIds: transactions.map((transaction) => transaction.id) }
}

export async function createAffiliatePayout(
  em: EntityManager,
  container: AwilixContainer,
  input: FinooPayoutConfirmGroupInput,
  scope: FinooScope,
  now = new Date(),
): Promise<{ payout: FinooAffiliatePayout; created: boolean; transactionIds: string[] }> {
  return em.transactional(async (transactionalEm) => {
    await assertExactPayoutBatch(transactionalEm, [input], null, scope, true)
    const paidOut = await loadPaidOutStatusEntry(transactionalEm, scope)
    return createAffiliatePayoutInTransaction(transactionalEm, container, input, scope, paidOut, now)
  })
}

export async function createAffiliatePayoutBatch(
  em: EntityManager,
  container: AwilixContainer,
  groups: FinooPayoutConfirmGroupInput[],
  batchId: string,
  scope: FinooScope,
  now = new Date(),
): Promise<PayoutBatchCreationResult> {
  return em.transactional(async (transactionalEm) => {
    const canonicalGroups = await assertExactPayoutBatch(transactionalEm, groups, batchId, scope, true)
    const paidOut = await loadPaidOutStatusEntry(transactionalEm, scope)
    const payouts = []
    for (const group of canonicalGroups) {
      payouts.push(await createAffiliatePayoutInTransaction(
        transactionalEm,
        container,
        group,
        scope,
        paidOut,
        now,
      ))
    }
    return { payouts }
  })
}

export async function validatePayoutBatchConfirmation(
  em: EntityManager,
  groups: FinooPayoutConfirmGroupInput[],
  batchId: string | null,
  scope: FinooScope,
  now = new Date(),
): Promise<{ payouts: FinooAffiliatePayout[] | null }> {
  const canonicalGroups = await assertExactPayoutBatch(em, groups, batchId, scope, false)
  const validations = []
  for (const group of canonicalGroups) {
    validations.push(await validatePayoutConfirmation(em, group, scope, now))
  }
  const completed = validations.filter((validation) => validation.payout !== null)
  if (completed.length > 0 && completed.length !== validations.length) {
    throw new CrudHttpError(409, { error: 'PAYOUT_PREVIEW_STALE' })
  }
  return {
    payouts: completed.length === validations.length
      ? completed.map((validation) => validation.payout as FinooAffiliatePayout)
      : null,
  }
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
