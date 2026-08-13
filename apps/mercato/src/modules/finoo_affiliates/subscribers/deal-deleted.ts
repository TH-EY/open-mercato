import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandBus } from '@open-mercato/shared/lib/commands'
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
  const commandBus = parentContainer.resolve<CommandBus>('commandBus')
  await commandBus.execute('finoo_affiliates.transaction.create', {
    input: { dealId: payload.id, includeDeletedDeal: true },
    ctx: {
      container: parentContainer as never,
      auth: { tenantId: scope.tenantId } as never,
      organizationScope: null,
      selectedOrganizationId: scope.organizationId,
      organizationIds: [scope.organizationId],
      systemActor: true,
    },
  })
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
