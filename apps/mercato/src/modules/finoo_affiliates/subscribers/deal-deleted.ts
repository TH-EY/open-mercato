import type { EntityManager } from '@mikro-orm/postgresql'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { FinooDealAttribution } from '../data/entities'
import { emitFinooAffiliateEvent } from '../events'
import type { DealEventPayload, SubscriberContext } from '../lib/attributionSync'

export const metadata = {
  event: 'customers.deal.deleted',
  persistent: true,
  id: 'finoo_affiliates:deal-deleted-attribution',
}

export default async function handleDealDeleted(payload: DealEventPayload, context: SubscriberContext): Promise<void> {
  if (typeof payload.id !== 'string' || typeof payload.tenantId !== 'string' || typeof payload.organizationId !== 'string') return
  const scope = { tenantId: payload.tenantId, organizationId: payload.organizationId }
  const parentContainer = context.container ?? context
  const em = parentContainer.resolve<EntityManager>('em').fork()
  const attribution = await findOneWithDecryption(
    em,
    FinooDealAttribution,
    { dealId: payload.id, ...scope, deletedAt: null },
    undefined,
    scope,
  )
  if (!attribution) return
  attribution.deletedAt = new Date()
  attribution.deletionReason = 'deal'
  await em.flush()
  await emitFinooAffiliateEvent('finoo_affiliates.deal_attribution.deleted', {
    id: attribution.id,
    dealId: attribution.dealId,
    tenantId: attribution.tenantId,
    organizationId: attribution.organizationId,
    affiliateUserId: attribution.affiliateUserId,
  }, { persistent: true })
}
