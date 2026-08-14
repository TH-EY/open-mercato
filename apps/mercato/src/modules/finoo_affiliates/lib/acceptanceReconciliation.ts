import type { EntityManager } from '@mikro-orm/postgresql'
import type { FinooScope } from './service'

export const FINOO_ACCEPTANCE_RECONCILIATION_QUEUE = 'finoo-affiliates-acceptance-reconciliation'
export const FINOO_ACCEPTANCE_RECONCILIATION_BATCH_SIZE = 100

type MissingTransactionRow = {
  deal_id: string
  acceptance_id: string
  accepted_at: Date | string
}
export type AcceptanceReconciliationCursor = { acceptedAt: string; acceptanceId: string }
export type AcceptanceReconciliationResult = {
  selected: number
  succeeded: number
  failed: number
  continuation: AcceptanceReconciliationCursor | null
}

type AcceptanceReconciliationOptions = {
  batchSize?: number
  after?: AcceptanceReconciliationCursor | null
  onFailure?: (dealId: string, error: unknown) => void
}

export async function reconcileAcceptedDeals(
  em: EntityManager,
  scope: FinooScope,
  createTransaction: (dealId: string) => Promise<boolean>,
  options: AcceptanceReconciliationOptions = {},
): Promise<AcceptanceReconciliationResult> {
  const batchSize = options.batchSize ?? FINOO_ACCEPTANCE_RECONCILIATION_BATCH_SIZE
  const cursorPredicate = options.after
    ? 'and (acceptance.accepted_at, acceptance.id) > (?, ?)'
    : ''
  const rows = await em.getConnection().execute<MissingTransactionRow[]>(
    `select acceptance.deal_id, acceptance.id as acceptance_id, acceptance.accepted_at
       from finoo_deal_acceptances acceptance
       inner join finoo_deal_attributions attribution
         on attribution.tenant_id = acceptance.tenant_id
        and attribution.organization_id = acceptance.organization_id
        and attribution.deal_id = acceptance.deal_id
        and attribution.deleted_at is null
       inner join customer_deals deal
         on deal.tenant_id = acceptance.tenant_id
        and deal.organization_id = acceptance.organization_id
        and deal.id = acceptance.deal_id
        and deal.deleted_at is null
       inner join finoo_affiliates affiliate
         on affiliate.tenant_id = acceptance.tenant_id
        and affiliate.organization_id = acceptance.organization_id
        and affiliate.customer_user_id = attribution.affiliate_user_id
        and (attribution.affiliate_id is null or affiliate.id = attribution.affiliate_id)
        and affiliate.is_active = true
        and affiliate.deleted_at is null
       left join finoo_affiliate_transactions transaction
         on transaction.tenant_id = acceptance.tenant_id
        and transaction.organization_id = acceptance.organization_id
        and transaction.deal_id = acceptance.deal_id
      where acceptance.tenant_id = ?
        and acceptance.organization_id = ?
        ${cursorPredicate}
        and (transaction.id is null or transaction.created_event_published_at is null)
      order by acceptance.accepted_at asc, acceptance.id asc
      limit ?`,
    [
      scope.tenantId,
      scope.organizationId,
      ...(options.after ? [options.after.acceptedAt, options.after.acceptanceId] : []),
      batchSize,
    ],
  )
  let succeeded = 0
  let failed = 0
  for (const row of rows) {
    try {
      if (await createTransaction(row.deal_id)) succeeded += 1
    } catch (error) {
      failed += 1
      options.onFailure?.(row.deal_id, error)
    }
  }
  const last = rows.at(-1)
  return {
    selected: rows.length,
    succeeded,
    failed,
    continuation: last
      ? {
          acceptedAt: new Date(last.accepted_at).toISOString(),
          acceptanceId: last.acceptance_id,
        }
      : null,
  }
}
