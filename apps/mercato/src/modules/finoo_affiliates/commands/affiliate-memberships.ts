import { z } from 'zod'
import { LockMode } from '@mikro-orm/core'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandHandler, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { registerCommand } from '@open-mercato/shared/lib/commands'
import { extractUndoPayload } from '@open-mercato/shared/lib/commands/undo'
import { ensureOrganizationScope, ensureTenantScope } from '@open-mercato/shared/lib/commands/scope'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { enforceCommandOptimisticLockWithGuards } from '@open-mercato/shared/lib/crud/optimistic-lock-command'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { FinooAffiliate } from '../data/entities'
import { finooAffiliateCommissionUpdateSchema } from '../data/validators'
import { emitFinooAffiliateEvent } from '../events'
import { activateAffiliateForInvitation, ensureAffiliateForInvitation } from '../lib/membership'
import type { FinooScope } from '../lib/service'

const ensureInputSchema = z.object({
  invitationId: z.string().uuid(),
  tenantId: z.string().uuid(),
  organizationId: z.string().uuid(),
})

const activateInputSchema = ensureInputSchema.extend({ userId: z.string().uuid() })

export type EnsureAffiliateInvitationInput = z.infer<typeof ensureInputSchema>
export type ActivateAffiliateInvitationInput = z.infer<typeof activateInputSchema>
export type EnsureAffiliateInvitationOutput = { affiliate: FinooAffiliate; created: boolean }

function requireScope(ctx: CommandRuntimeContext, input: FinooScope): FinooScope {
  const scope = { tenantId: input.tenantId, organizationId: input.organizationId }
  if (ctx.systemActor) return scope
  const tenantId = ctx.auth?.tenantId
  const organizationId = ctx.selectedOrganizationId ?? ctx.auth?.orgId
  if (tenantId !== input.tenantId || organizationId !== input.organizationId) {
    throw new CrudHttpError(403, { error: 'Forbidden' })
  }
  ensureTenantScope(ctx, input.tenantId)
  ensureOrganizationScope(ctx, input.organizationId)
  return scope
}

const ensureInvitationCommand: CommandHandler<EnsureAffiliateInvitationInput, EnsureAffiliateInvitationOutput> = {
  id: 'finoo_affiliates.affiliate.ensure_invitation',
  isUndoable: true,
  async execute(rawInput, ctx) {
    const input = ensureInputSchema.parse(rawInput)
    const scope = requireScope(ctx, input)
    const em = ctx.container.resolve('em') as EntityManager
    const result = await ensureAffiliateForInvitation(em, input.invitationId, scope)
    if (result.created) {
      await emitFinooAffiliateEvent('finoo_affiliates.affiliate.created', {
        id: result.affiliate.id,
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
      }, { persistent: true })
    }
    return result
  },
  async buildLog({ result }) {
    return {
      actionLabel: 'Ensure Finoo affiliate invitation',
      resourceKind: 'finoo_affiliates.affiliate',
      resourceId: result.affiliate.id,
      tenantId: result.affiliate.tenantId,
      organizationId: result.affiliate.organizationId,
      payload: { undo: { created: result.created, affiliateId: result.affiliate.id } },
    }
  },
  async undo({ logEntry, ctx }) {
    const payload = extractUndoPayload<{ created?: boolean; affiliateId?: string }>(logEntry)
    if (!payload?.created || !payload.affiliateId) return
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const affiliate = await findOneWithDecryption(em, FinooAffiliate, { id: payload.affiliateId }, undefined, {})
    if (!affiliate || affiliate.customerUserId || affiliate.isActive) return
    affiliate.deletedAt = new Date()
    await em.flush()
  },
}

const activateInvitationCommand: CommandHandler<ActivateAffiliateInvitationInput, FinooAffiliate> = {
  id: 'finoo_affiliates.affiliate.activate',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const input = activateInputSchema.parse(rawInput)
    const scope = requireScope(ctx, input)
    const em = ctx.container.resolve('em') as EntityManager
    const result = await activateAffiliateForInvitation(em, input.invitationId, input.userId, scope)
    if (result.activated) {
      await emitFinooAffiliateEvent('finoo_affiliates.affiliate.activated', {
        id: result.affiliate.id,
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        affiliateUserId: input.userId,
      }, { persistent: true })
    }
    return result.affiliate
  },
}

const updateCommissionCommand: CommandHandler<Record<string, unknown>, FinooAffiliate> = {
  id: 'finoo_affiliates.affiliate.update_commission',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const input = finooAffiliateCommissionUpdateSchema.parse(rawInput)
    const tenantId = ctx.auth?.tenantId
    const organizationId = ctx.selectedOrganizationId ?? ctx.auth?.orgId
    if (!tenantId || !organizationId) throw new CrudHttpError(403, { error: 'Forbidden' })
    const scope = { tenantId, organizationId }
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const affiliate = await em.transactional(async (transactionalEm) => {
      const locked = await findOneWithDecryption(
        transactionalEm,
        FinooAffiliate,
        { id: input.id, ...scope, deletedAt: null },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
        scope,
      )
      if (!locked) throw new CrudHttpError(404, { error: 'Not found' })
      await enforceCommandOptimisticLockWithGuards(ctx.container, {
        resourceKind: 'finoo_affiliates.affiliate',
        resourceId: locked.id,
        current: locked.updatedAt,
        expected: input.updatedAt,
        request: ctx.request,
      })
      locked.commissionMode = input.commissionMode
      locked.commissionRateBps = input.commissionRateBps
      locked.commissionFixedAmount = input.commissionFixedAmount
      await transactionalEm.flush()
      return locked
    })
    return affiliate
  },
  async buildLog({ result }) {
    return {
      actionLabel: 'Update Finoo affiliate commission',
      resourceKind: 'finoo_affiliates.affiliate',
      resourceId: result.id,
      tenantId: result.tenantId,
      organizationId: result.organizationId,
    }
  },
}

registerCommand(ensureInvitationCommand)
registerCommand(activateInvitationCommand)
registerCommand(updateCommissionCommand)
