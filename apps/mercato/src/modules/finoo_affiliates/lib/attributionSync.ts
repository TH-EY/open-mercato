import type { EntityManager } from '@mikro-orm/postgresql'
import { loadCustomFieldValues } from '@open-mercato/shared/lib/crud/custom-fields'
import { normalizeCustomFieldResponse } from '@open-mercato/shared/lib/custom-fields/normalize'
import { findOneWithDecryption, findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import {
  CustomerDeal,
  CustomerDealCompanyLink,
  CustomerDealStageTransition,
} from '@open-mercato/core/modules/customers/data/entities'
import { FinooAffiliateLink, FinooDealAttribution, FinooDealCompletion } from '../data/entities'
import type { FinooAffiliateService, FinooScope } from './service'
import { emitFinooAffiliateEvent } from '../events'

type DealEventPayload = {
  id?: unknown
  tenantId?: unknown
  organizationId?: unknown
}

type SubscriberContext = {
  resolve: <T = unknown>(name: string) => T
  container?: { resolve<T = unknown>(name: string): T }
}

function resolveFromContext<T>(context: SubscriberContext, name: string): T {
  return context.container?.resolve<T>(name) ?? context.resolve<T>(name)
}

function readBoundedCustomField(
  customFields: Record<string, unknown>,
  configuredKey: string,
  maxLength: number,
): string | null {
  const normalizedKey = configuredKey.trim().replace(/^cf[_:]/, '')
  const candidates = [normalizedKey, `cf_${normalizedKey}`, `cf:${normalizedKey}`]
  for (const candidate of candidates) {
    const value = customFields[candidate]
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed.length > 0) return trimmed.slice(0, maxLength)
  }
  return null
}

async function loadCompanyName(em: EntityManager, deal: CustomerDeal, scope: FinooScope): Promise<string | null> {
  const links = await findWithDecryption(
    em,
    CustomerDealCompanyLink,
    { deal: deal.id },
    { populate: ['company'], orderBy: { createdAt: 'ASC' }, limit: 1 },
    scope,
  )
  const company = links[0]?.company
  if (!company || company.tenantId !== scope.tenantId || company.organizationId !== scope.organizationId || company.deletedAt) return null
  const displayName = typeof company.displayName === 'string' ? company.displayName.trim() : ''
  return displayName.length > 0 ? displayName.slice(0, 300) : null
}

export async function loadFirstCompletedAt(em: EntityManager, dealId: string, scope: FinooScope): Promise<Date | null> {
  const captured = await findOneWithDecryption(
    em,
    FinooDealCompletion,
    { dealId, tenantId: scope.tenantId, organizationId: scope.organizationId },
    undefined,
    scope,
  )
  if (captured) return captured.completedAt
  const transitions = await findWithDecryption(
    em,
    CustomerDealStageTransition,
    {
      deal: dealId,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      isActive: true,
      deletedAt: null,
    },
    { orderBy: { transitionedAt: 'ASC' } },
    scope,
  )
  return transitions.find((transition) => transition.stageLabel.trim().toLowerCase() === 'completed')?.transitionedAt ?? null
}

export async function synchronizeFinooDealAttribution(
  payload: DealEventPayload,
  context: SubscriberContext,
): Promise<void> {
  if (typeof payload.id !== 'string' || typeof payload.tenantId !== 'string' || typeof payload.organizationId !== 'string') return
  const scope = { tenantId: payload.tenantId, organizationId: payload.organizationId }
  const em = (resolveFromContext<EntityManager>(context, 'em')).fork()
  const service = resolveFromContext<FinooAffiliateService>(context, 'finooAffiliateService')
  const deal = await findOneWithDecryption(
    em,
    CustomerDeal,
    { id: payload.id, tenantId: scope.tenantId, organizationId: scope.organizationId, deletedAt: null },
    undefined,
    scope,
  )
  if (!deal) return

  const customFieldValues = await loadCustomFieldValues({
    em,
    entityId: 'customers:customer_deal',
    recordIds: [deal.id],
    tenantIdByRecord: { [deal.id]: scope.tenantId },
    organizationIdByRecord: { [deal.id]: scope.organizationId },
    tenantFallbacks: [scope.tenantId],
  })
  const customFields = normalizeCustomFieldResponse(customFieldValues[deal.id]) ?? {}
  const affiliateCode = readBoundedCustomField(
    customFields,
    process.env.OM_FINOO_AFFILIATE_CODE_FIELD ?? 'affiliate_code',
    128,
  )
  let attribution = await findOneWithDecryption(
    em,
    FinooDealAttribution,
    { dealId: deal.id, tenantId: scope.tenantId, organizationId: scope.organizationId },
    undefined,
    scope,
  )
  if (attribution?.deletedAt && attribution.deletionReason !== 'deal') return

  let link: FinooAffiliateLink | null = null
  if (!attribution && affiliateCode) {
    link = await findOneWithDecryption(
      em,
      FinooAffiliateLink,
      { code: affiliateCode, tenantId: scope.tenantId, organizationId: scope.organizationId, isActive: true, deletedAt: null },
      undefined,
      scope,
    )
  }
  if (!attribution && !link) return

  const [companyName, completedAt] = await Promise.all([
    loadCompanyName(em, deal, scope),
    loadFirstCompletedAt(em, deal.id, scope),
  ])
  const landingPage = readBoundedCustomField(
    customFields,
    process.env.OM_FINOO_LANDING_PAGE_FIELD ?? 'landing_page',
    2048,
  )
  const initialReferrer = readBoundedCustomField(
    customFields,
    process.env.OM_FINOO_INITIAL_REFERRER_FIELD ?? 'initial_referrer',
    2048,
  )

  const wasCreated = !attribution
  if (!attribution && link) {
    const commission = await service.getDefaultCommissionStatus(scope)
    attribution = em.create(FinooDealAttribution, {
      ...scope,
      dealId: deal.id,
      affiliateUserId: link.affiliateUserId,
      affiliateCode: link.code,
      companyName,
      landingPage,
      initialReferrer,
      commissionStatusEntryId: commission.entry.id,
      commissionStatus: commission.status,
      commissionAmount: 0,
      leadAt: deal.createdAt,
      transactionAt: completedAt,
      attributionSource: 'automatic',
    })
    em.persist(attribution)
  } else if (attribution) {
    attribution.deletedAt = null
    attribution.deletionReason = null
    attribution.companyName = companyName
    attribution.landingPage = landingPage
    attribution.initialReferrer = initialReferrer
    if (!attribution.transactionAt && completedAt) attribution.transactionAt = completedAt
  }

  if (!attribution) return
  try {
    await em.flush()
  } catch (error) {
    if (!wasCreated) throw error
    const concurrent = await findOneWithDecryption(
      em.fork(),
      FinooDealAttribution,
      { dealId: deal.id, tenantId: scope.tenantId, organizationId: scope.organizationId, deletedAt: null },
      undefined,
      scope,
    )
    if (concurrent) return
    throw error
  }

  await emitFinooAffiliateEvent(
    wasCreated ? 'finoo_affiliates.deal_attribution.created' : 'finoo_affiliates.deal_attribution.updated',
    {
      id: attribution.id,
      dealId: attribution.dealId,
      tenantId: attribution.tenantId,
      organizationId: attribution.organizationId,
      affiliateUserId: attribution.affiliateUserId,
    },
    { persistent: true },
  )
}

export type { DealEventPayload, SubscriberContext }
