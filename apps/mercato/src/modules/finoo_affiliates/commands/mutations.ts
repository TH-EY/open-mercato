import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandHandler, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { registerCommand } from '@open-mercato/shared/lib/commands'
import { ensureOrganizationScope, ensureTenantScope } from '@open-mercato/shared/lib/commands/scope'
import { extractUndoPayload } from '@open-mercato/shared/lib/commands/undo'
import { buildChanges } from '@open-mercato/shared/lib/commands/helpers'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { enforceCommandOptimisticLock } from '@open-mercato/shared/lib/crud/optimistic-lock-command'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { CustomerDeal } from '@open-mercato/core/modules/customers/data/entities'
import {
  finooAffiliateLinkCreateSchema,
  finooAffiliateLinkDeleteSchema,
  finooAffiliateLinkUpdateSchema,
  finooDealAttributionUpsertSchema,
} from '../data/validators'
import { FinooAffiliate, FinooAffiliateLink, FinooDealAttribution } from '../data/entities'
import { emitFinooAffiliateEvent } from '../events'
import { type FinooAffiliateService, type FinooScope } from '../lib/service'
import { loadFirstCompletedAt } from '../lib/attributionSync'

type LinkSnapshot = {
  id: string
  tenantId: string
  organizationId: string
  affiliateUserId: string
  code: string
  label: string
  destinationUrl: string
  isActive: boolean
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

type AttributionSnapshot = {
  id: string
  tenantId: string
  organizationId: string
  dealId: string
  affiliateUserId: string
  affiliateId: string | null
  affiliateCode: string
  companyName: string | null
  landingPage: string | null
  initialReferrer: string | null
  commissionStatusEntryId: string
  commissionStatus: string
  commissionAmount: number
  leadAt: string
  transactionAt: string | null
  attributionSource: string
  deletionReason: string | null
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

type UndoPayload<TSnapshot> = { before?: TSnapshot; after?: TSnapshot }

function requireScope(ctx: CommandRuntimeContext): FinooScope {
  const tenantId = ctx.auth?.tenantId
  const organizationId = ctx.selectedOrganizationId ?? ctx.auth?.orgId
  if (!tenantId || !organizationId) throw new CrudHttpError(403, { error: 'Forbidden' })
  ensureTenantScope(ctx, tenantId)
  ensureOrganizationScope(ctx, organizationId)
  return { tenantId, organizationId }
}

function linkSnapshot(link: FinooAffiliateLink): LinkSnapshot {
  return {
    id: link.id,
    tenantId: link.tenantId,
    organizationId: link.organizationId,
    affiliateUserId: link.affiliateUserId,
    code: link.code,
    label: link.label,
    destinationUrl: link.destinationUrl,
    isActive: link.isActive,
    createdAt: link.createdAt.toISOString(),
    updatedAt: link.updatedAt.toISOString(),
    deletedAt: link.deletedAt?.toISOString() ?? null,
  }
}

function attributionSnapshot(attribution: FinooDealAttribution): AttributionSnapshot {
  return {
    id: attribution.id,
    tenantId: attribution.tenantId,
    organizationId: attribution.organizationId,
    dealId: attribution.dealId,
    affiliateUserId: attribution.affiliateUserId,
    affiliateId: attribution.affiliateId ?? null,
    affiliateCode: attribution.affiliateCode,
    companyName: attribution.companyName ?? null,
    landingPage: attribution.landingPage ?? null,
    initialReferrer: attribution.initialReferrer ?? null,
    commissionStatusEntryId: attribution.commissionStatusEntryId,
    commissionStatus: attribution.commissionStatus,
    commissionAmount: attribution.commissionAmount,
    leadAt: attribution.leadAt.toISOString(),
    transactionAt: attribution.transactionAt?.toISOString() ?? null,
    attributionSource: attribution.attributionSource,
    deletionReason: attribution.deletionReason ?? null,
    createdAt: attribution.createdAt.toISOString(),
    updatedAt: attribution.updatedAt.toISOString(),
    deletedAt: attribution.deletedAt?.toISOString() ?? null,
  }
}

async function loadLink(em: EntityManager, id: string, scope: FinooScope, includeDeleted = false): Promise<FinooAffiliateLink> {
  const link = await findOneWithDecryption(
    em,
    FinooAffiliateLink,
    { id, tenantId: scope.tenantId, organizationId: scope.organizationId, ...(includeDeleted ? {} : { deletedAt: null }) },
    undefined,
    scope,
  )
  if (!link) throw new CrudHttpError(404, { error: '[internal] Affiliate link was not found' })
  return link
}

async function isPrimaryAffiliateLink(em: EntityManager, link: FinooAffiliateLink, scope: FinooScope): Promise<boolean> {
  const affiliate = await findOneWithDecryption(
    em,
    FinooAffiliate,
    { ...scope, primaryLinkId: link.id, deletedAt: null },
    undefined,
    scope,
  )
  return Boolean(affiliate)
}

async function rejectPrimaryLinkMutation(em: EntityManager, link: FinooAffiliateLink, scope: FinooScope): Promise<void> {
  if (await isPrimaryAffiliateLink(em, link, scope)) {
    throw new CrudHttpError(409, { error: 'PRIMARY_AFFILIATE_LINK_IMMUTABLE' })
  }
}

async function emitLinkEvent(action: 'created' | 'updated' | 'deleted', link: FinooAffiliateLink): Promise<void> {
  await emitFinooAffiliateEvent(`finoo_affiliates.affiliate_link.${action}`, {
    id: link.id,
    tenantId: link.tenantId,
    organizationId: link.organizationId,
    affiliateUserId: link.affiliateUserId,
  }, { persistent: true })
}

async function emitAttributionEvent(action: 'created' | 'updated' | 'deleted', attribution: FinooDealAttribution): Promise<void> {
  await emitFinooAffiliateEvent(`finoo_affiliates.deal_attribution.${action}`, {
    id: attribution.id,
    dealId: attribution.dealId,
    tenantId: attribution.tenantId,
    organizationId: attribution.organizationId,
    affiliateUserId: attribution.affiliateUserId,
  }, { persistent: true })
}

const createLinkCommand: CommandHandler<Record<string, unknown>, FinooAffiliateLink> = {
  id: 'finoo_affiliates.links.create',
  isUndoable: true,
  async execute(rawInput, ctx) {
    const input = finooAffiliateLinkCreateSchema.parse(rawInput)
    const scope = requireScope(ctx)
    const em = ctx.container.resolve('em') as EntityManager
    const service = ctx.container.resolve('finooAffiliateService') as FinooAffiliateService
    await service.requireAffiliateUser(input.affiliateUserId, scope)
    const destinationUrl = await service.requireAllowedDestination(input.destinationUrl)
    const link = await service.withAvailableAffiliateCode(async (transactionalEm, code) => {
      const created = transactionalEm.create(FinooAffiliateLink, {
        ...scope,
        affiliateUserId: input.affiliateUserId,
        code,
        label: input.label,
        destinationUrl,
        isActive: input.isActive,
      })
      transactionalEm.persist(created)
      await transactionalEm.flush()
      return created
    })
    await emitLinkEvent('created', link)
    return link
  },
  captureAfter: (_input, result) => linkSnapshot(result),
  async buildLog({ result }) {
    const { translate } = await resolveTranslations()
    const after = linkSnapshot(result)
    return {
      actionLabel: translate('finooAffiliates.audit.links.create', 'Create affiliate link'),
      resourceKind: 'finoo_affiliates.affiliate_link',
      resourceId: result.id,
      tenantId: result.tenantId,
      organizationId: result.organizationId,
      snapshotAfter: after,
      payload: { undo: { after } satisfies UndoPayload<LinkSnapshot> },
    }
  },
  async undo({ logEntry, ctx }) {
    const after = extractUndoPayload<UndoPayload<LinkSnapshot>>(logEntry)?.after
    if (!after) return
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const scope = { tenantId: after.tenantId, organizationId: after.organizationId }
    const link = await loadLink(em, after.id, scope)
    await rejectPrimaryLinkMutation(em, link, scope)
    link.deletedAt = new Date()
    await em.flush()
    await emitLinkEvent('deleted', link)
  },
}

const updateLinkCommand: CommandHandler<Record<string, unknown>, FinooAffiliateLink> = {
  id: 'finoo_affiliates.links.update',
  isUndoable: true,
  async prepare(rawInput, ctx) {
    const input = finooAffiliateLinkUpdateSchema.parse(rawInput)
    const scope = requireScope(ctx)
    const em = ctx.container.resolve('em') as EntityManager
    return { before: linkSnapshot(await loadLink(em, input.id, scope)) }
  },
  async execute(rawInput, ctx) {
    const input = finooAffiliateLinkUpdateSchema.parse(rawInput)
    const scope = requireScope(ctx)
    const em = ctx.container.resolve('em') as EntityManager
    const service = ctx.container.resolve('finooAffiliateService') as FinooAffiliateService
    const link = await loadLink(em, input.id, scope)
    if (input.affiliateUserId !== undefined || input.destinationUrl !== undefined || input.isActive !== undefined) {
      await rejectPrimaryLinkMutation(em, link, scope)
    }
    if (input.affiliateUserId) {
      await service.requireAffiliateUser(input.affiliateUserId, scope)
      link.affiliateUserId = input.affiliateUserId
    }
    if (input.label !== undefined) link.label = input.label
    if (input.destinationUrl !== undefined) link.destinationUrl = await service.requireAllowedDestination(input.destinationUrl)
    if (input.isActive !== undefined) link.isActive = input.isActive
    await em.flush()
    await emitLinkEvent('updated', link)
    return link
  },
  captureAfter: (_input, result) => linkSnapshot(result),
  async buildLog({ snapshots, result }) {
    const { translate } = await resolveTranslations()
    const before = snapshots.before as LinkSnapshot | undefined
    if (!before) return null
    const after = linkSnapshot(result)
    return {
      actionLabel: translate('finooAffiliates.audit.links.update', 'Update affiliate link'),
      resourceKind: 'finoo_affiliates.affiliate_link',
      resourceId: result.id,
      tenantId: result.tenantId,
      organizationId: result.organizationId,
      snapshotBefore: before,
      snapshotAfter: after,
      changes: buildChanges(before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>, ['affiliateUserId', 'label', 'destinationUrl', 'isActive']),
      payload: { undo: { before, after } satisfies UndoPayload<LinkSnapshot> },
    }
  },
  async undo({ logEntry, ctx }) {
    const before = extractUndoPayload<UndoPayload<LinkSnapshot>>(logEntry)?.before
    if (!before) return
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const scope = { tenantId: before.tenantId, organizationId: before.organizationId }
    const link = await loadLink(em, before.id, scope, true)
    await rejectPrimaryLinkMutation(em, link, scope)
    link.affiliateUserId = before.affiliateUserId
    link.label = before.label
    link.destinationUrl = before.destinationUrl
    link.isActive = before.isActive
    link.deletedAt = before.deletedAt ? new Date(before.deletedAt) : null
    await em.flush()
    await emitLinkEvent('updated', link)
  },
}

const deleteLinkCommand: CommandHandler<Record<string, unknown>, FinooAffiliateLink> = {
  id: 'finoo_affiliates.links.delete',
  isUndoable: true,
  async prepare(rawInput, ctx) {
    const input = finooAffiliateLinkDeleteSchema.parse(rawInput)
    const scope = requireScope(ctx)
    const em = ctx.container.resolve('em') as EntityManager
    return { before: linkSnapshot(await loadLink(em, input.id, scope)) }
  },
  async execute(rawInput, ctx) {
    const input = finooAffiliateLinkDeleteSchema.parse(rawInput)
    const scope = requireScope(ctx)
    const em = ctx.container.resolve('em') as EntityManager
    const link = await loadLink(em, input.id, scope)
    await rejectPrimaryLinkMutation(em, link, scope)
    link.deletedAt = new Date()
    await em.flush()
    await emitLinkEvent('deleted', link)
    return link
  },
  async buildLog({ snapshots, result }) {
    const { translate } = await resolveTranslations()
    const before = snapshots.before as LinkSnapshot | undefined
    if (!before) return null
    return {
      actionLabel: translate('finooAffiliates.audit.links.delete', 'Delete affiliate link'),
      resourceKind: 'finoo_affiliates.affiliate_link',
      resourceId: result.id,
      tenantId: result.tenantId,
      organizationId: result.organizationId,
      snapshotBefore: before,
      payload: { undo: { before } satisfies UndoPayload<LinkSnapshot> },
    }
  },
  async undo({ logEntry, ctx }) {
    const before = extractUndoPayload<UndoPayload<LinkSnapshot>>(logEntry)?.before
    if (!before) return
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const link = await loadLink(em, before.id, { tenantId: before.tenantId, organizationId: before.organizationId }, true)
    link.deletedAt = null
    await em.flush()
    await emitLinkEvent('created', link)
  },
}

const upsertAttributionCommand: CommandHandler<Record<string, unknown>, FinooDealAttribution> = {
  id: 'finoo_affiliates.deal_attributions.upsert',
  isUndoable: true,
  async prepare(rawInput, ctx) {
    const input = finooDealAttributionUpsertSchema.parse(rawInput)
    const scope = requireScope(ctx)
    const em = ctx.container.resolve('em') as EntityManager
    const existing = await findOneWithDecryption(
      em,
      FinooDealAttribution,
      { dealId: input.dealId, tenantId: scope.tenantId, organizationId: scope.organizationId },
      undefined,
      scope,
    )
    return existing ? { before: attributionSnapshot(existing) } : {}
  },
  async execute(rawInput, ctx) {
    const input = finooDealAttributionUpsertSchema.parse(rawInput)
    const scope = requireScope(ctx)
    const em = ctx.container.resolve('em') as EntityManager
    const service = ctx.container.resolve('finooAffiliateService') as FinooAffiliateService
    await service.requireAffiliateUser(input.affiliateUserId, scope)
    const commission = await service.requireCommissionStatus(input.commissionStatusEntryId, scope)
    const deal = await findOneWithDecryption(
      em,
      CustomerDeal,
      { id: input.dealId, tenantId: scope.tenantId, organizationId: scope.organizationId, deletedAt: null },
      undefined,
      scope,
    )
    if (!deal) throw new CrudHttpError(404, { error: '[internal] Deal was not found' })
    const completedAt = await loadFirstCompletedAt(em, deal.id, scope)
    const affiliate = await findOneWithDecryption(
      em,
      FinooAffiliate,
      { customerUserId: input.affiliateUserId, ...scope, isActive: true, deletedAt: null },
      undefined,
      scope,
    )
    let attribution = await findOneWithDecryption(
      em,
      FinooDealAttribution,
      { dealId: input.dealId, tenantId: scope.tenantId, organizationId: scope.organizationId },
      undefined,
      scope,
    )
    const commandBus = ctx.container.resolve('commandBus') as import('@open-mercato/shared/lib/commands').CommandBus
    if (attribution) {
      await commandBus.execute(
        'finoo_affiliates.transaction.create',
        {
          input: { dealId: input.dealId },
          ctx: {
            container: ctx.container,
            auth: ctx.auth,
            organizationScope: ctx.organizationScope,
            selectedOrganizationId: scope.organizationId,
            organizationIds: [scope.organizationId],
            systemActor: true,
          },
        },
      )
    }
    const wasCreated = !attribution || Boolean(attribution.deletedAt)
    if (!attribution) {
      attribution = em.create(FinooDealAttribution, {
        ...scope,
        dealId: input.dealId,
        affiliateUserId: input.affiliateUserId,
        affiliateId: affiliate?.id ?? null,
        affiliateCode: '',
        commissionStatusEntryId: commission.entry.id,
        commissionStatus: commission.status,
        commissionAmount: input.commissionAmount,
        leadAt: deal.createdAt,
        transactionAt: completedAt,
        attributionSource: 'staff',
      })
      em.persist(attribution)
    } else {
      enforceCommandOptimisticLock({
        resourceKind: 'finoo_affiliates.deal_attribution',
        resourceId: attribution.id,
        current: attribution.updatedAt,
        request: ctx.request ?? null,
      })
      attribution.affiliateUserId = input.affiliateUserId
      attribution.affiliateId = affiliate?.id ?? null
      attribution.commissionStatusEntryId = commission.entry.id
      attribution.commissionStatus = commission.status
      attribution.commissionAmount = input.commissionAmount
      attribution.attributionSource = 'staff'
      attribution.deletedAt = null
      attribution.deletionReason = null
    }
    await em.flush()
    await emitAttributionEvent(wasCreated ? 'created' : 'updated', attribution)
    await commandBus.execute(
      'finoo_affiliates.transaction.create',
      {
        input: { dealId: input.dealId },
        ctx: {
          container: ctx.container,
          auth: ctx.auth,
          organizationScope: ctx.organizationScope,
          selectedOrganizationId: scope.organizationId,
          organizationIds: [scope.organizationId],
          systemActor: true,
        },
      },
    )
    return attribution
  },
  captureAfter: (_input, result) => attributionSnapshot(result),
  async buildLog({ snapshots, result }) {
    const { translate } = await resolveTranslations()
    const before = snapshots.before as AttributionSnapshot | undefined
    const after = attributionSnapshot(result)
    return {
      actionLabel: before
        ? translate('finooAffiliates.audit.attributions.update', 'Update Deal affiliate attribution')
        : translate('finooAffiliates.audit.attributions.create', 'Create Deal affiliate attribution'),
      resourceKind: 'finoo_affiliates.deal_attribution',
      resourceId: result.id,
      tenantId: result.tenantId,
      organizationId: result.organizationId,
      snapshotBefore: before,
      snapshotAfter: after,
      changes: before ? buildChanges(before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>, ['affiliateUserId', 'commissionStatus', 'commissionAmount']) : undefined,
      payload: { undo: { before, after } satisfies UndoPayload<AttributionSnapshot> },
    }
  },
  async undo({ logEntry, ctx }) {
    const payload = extractUndoPayload<UndoPayload<AttributionSnapshot>>(logEntry)
    const after = payload?.after
    if (!after) return
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const scope = { tenantId: after.tenantId, organizationId: after.organizationId }
    const attribution = await findOneWithDecryption(em, FinooDealAttribution, { id: after.id, ...scope }, undefined, scope)
    if (!attribution) return
    if (!payload.before) {
      attribution.deletedAt = new Date()
      attribution.deletionReason = 'staff'
      await em.flush()
      await emitAttributionEvent('deleted', attribution)
      return
    }
    const before = payload.before
    attribution.affiliateUserId = before.affiliateUserId
    attribution.affiliateId = before.affiliateId
    attribution.affiliateCode = before.affiliateCode
    attribution.companyName = before.companyName
    attribution.landingPage = before.landingPage
    attribution.initialReferrer = before.initialReferrer
    attribution.commissionStatusEntryId = before.commissionStatusEntryId
    if (before.commissionStatus === 'approved' || before.commissionStatus === 'waiting' || before.commissionStatus === 'rejected') {
      attribution.commissionStatus = before.commissionStatus
    }
    attribution.commissionAmount = before.commissionAmount
    attribution.leadAt = new Date(before.leadAt)
    attribution.transactionAt = before.transactionAt ? new Date(before.transactionAt) : null
    attribution.attributionSource = before.attributionSource === 'staff' ? 'staff' : 'automatic'
    attribution.deletionReason = before.deletionReason === 'deal' || before.deletionReason === 'staff'
      ? before.deletionReason
      : null
    attribution.deletedAt = before.deletedAt ? new Date(before.deletedAt) : null
    await em.flush()
    await emitAttributionEvent('updated', attribution)
  },
}

registerCommand(createLinkCommand)
registerCommand(updateLinkCommand)
registerCommand(deleteLinkCommand)
registerCommand(upsertAttributionCommand)
