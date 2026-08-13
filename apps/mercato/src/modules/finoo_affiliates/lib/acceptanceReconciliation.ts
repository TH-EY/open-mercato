import type { EntityManager } from '@mikro-orm/postgresql'
import type { FinooScope } from './service'

export const FINOO_ACCEPTANCE_RECONCILIATION_QUEUE = 'finoo-affiliates-acceptance-reconciliation'
export const FINOO_ACCEPTANCE_RECONCILIATION_BATCH_SIZE = 100

type MissingTransactionRow = { deal_id: string }
export type AcceptanceReconciliationResult = { selected: number; succeeded: number }

export async function reconcileAcceptedDeals(
  em: EntityManager,
  scope: FinooScope,
  createTransaction: (dealId: string) => Promise<boolean>,
  batchSize = FINOO_ACCEPTANCE_RECONCILIATION_BATCH_SIZE,
): Promise<AcceptanceReconciliationResult> {
  const rows = await em.getConnection().execute<MissingTransactionRow[]>(
    `select acceptance.deal_id
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
        and (transaction.id is null or transaction.created_event_published_at is null)
      order by acceptance.accepted_at asc, acceptance.id asc
      limit ?`,
    [scope.tenantId, scope.organizationId, batchSize],
  )
  let succeeded = 0
  for (const row of rows) {
    if (await createTransaction(row.deal_id)) succeeded += 1
  }
  return { selected: rows.length, succeeded }
}
