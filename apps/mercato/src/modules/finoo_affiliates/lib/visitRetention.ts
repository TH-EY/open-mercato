import type { EntityManager } from '@mikro-orm/postgresql'

export const FINOO_AFFILIATE_VISITOR_WINDOW_MS = 24 * 60 * 60 * 1000
export const FINOO_AFFILIATE_VISITOR_PRUNE_QUEUE = 'finoo-affiliate-visitor-prune'
export const FINOO_AFFILIATE_VISITOR_PRUNE_BATCH_SIZE = 1_000

type FinooScope = { tenantId: string; organizationId: string }

export async function anonymizeExpiredAffiliateVisitors(
  em: EntityManager,
  scope: FinooScope,
  options: { now?: Date; batchSize?: number } = {},
): Promise<number> {
  const now = options.now ?? new Date()
  const batchSize = options.batchSize ?? FINOO_AFFILIATE_VISITOR_PRUNE_BATCH_SIZE
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error('[internal] Affiliate visitor prune batch size must be a positive integer')
  }
  const cutoff = new Date(now.getTime() - FINOO_AFFILIATE_VISITOR_WINDOW_MS)
  const result = await em.getConnection().execute(
    `
      update finoo_affiliate_visits
      set visitor_hash = null, updated_at = ?
      where id in (
        select id from finoo_affiliate_visits
        where tenant_id = ?
          and organization_id = ?
          and visitor_hash is not null
          and visited_at < ?
        order by visited_at asc
        limit ?
      )
    `,
    [now, scope.tenantId, scope.organizationId, cutoff, batchSize],
    'run',
  ) as { affectedRows?: number; rowCount?: number } | undefined
  return result?.affectedRows ?? result?.rowCount ?? 0
}
