import { LockMode, UniqueConstraintViolationException } from '@mikro-orm/core'
import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import { z } from 'zod'
import {
  CustomerUser,
  CustomerUserInvitation,
} from '@open-mercato/core/modules/customer_accounts/data/entities'
import { sendCustomerInvitationEmail } from '@open-mercato/core/modules/customer_accounts/lib/invitationEmail'
import type { CustomerInvitationService } from '@open-mercato/core/modules/customer_accounts/services/customerInvitationService'
import type { CustomerRbacService } from '@open-mercato/core/modules/customer_accounts/services/customerRbacService'
import type { RbacService } from '@open-mercato/core/modules/auth/services/rbacService'
import {
  registerCommand,
  type CommandHandler,
  type CommandRuntimeContext,
} from '@open-mercato/shared/lib/commands'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { enforceCommandOptimisticLockWithGuards } from '@open-mercato/shared/lib/crud/optimistic-lock-command'
import { lookupHashCandidates } from '@open-mercato/shared/lib/encryption/aes'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import { createLogger } from '@open-mercato/shared/lib/logger'
import {
  intermediaryInviteSchema,
  intermediaryLifecycleActionSchema,
  intermediaryUpdateSchema,
} from '../data/validators'
import { FinooIntermediary } from '../data/entities'
import {
  emitFinooIntermediaryEvent,
  type FinooIntermediaryEventId,
} from '../events'
import { resolveEffectiveIntermediaryStatus } from '../lib/domain'
import { sendIntermediaryAccessNotice } from '../lib/directory-email'
import {
  directoryConflict,
  directoryNotFound,
  intermediaryEmailHash,
  loadCurrentInvitation,
  loadDirectoryByEmail,
  loadDirectoryById,
  loadIntermediaryMembership,
  loadIntermediaryRole,
  loadScopedCustomerUser,
  loadScopedCustomerUserByEmail,
  lockActiveUserSessions,
  normalizeIntermediaryEmail,
  restoreIntermediaryMembership,
  type IntermediaryDirectoryScope,
} from '../lib/directory-lifecycle'

const intermediaryIdSchema = z.object({ intermediaryId: z.string().uuid() }).strict()
const updateCommandSchema = intermediaryIdSchema.merge(intermediaryUpdateSchema)
const lifecycleCommandSchema = intermediaryIdSchema.merge(intermediaryLifecycleActionSchema)
const activateFromInvitationSchema = z.object({
  invitationId: z.string().uuid(),
  userId: z.string().uuid(),
  tenantId: z.string().uuid(),
}).strict()

const logger = createLogger('finoo_intermediaries').child({ component: 'commands.directory' })
const INTERMEDIARY_ENTITY_TYPE = 'finoo_intermediaries:finoo_intermediary'

type EventBus = {
  emitEvent(event: string, payload: unknown, options?: unknown): Promise<void>
}

type StaffDirectoryScope = IntermediaryDirectoryScope & { actorUserId: string }
type EmailDeliveryKind = 'invitation' | 'access_notice'
type EmailDeliveryPlan = {
  kind: EmailDeliveryKind
  intermediaryId: string
  invitationId: string | null
  email: string
  rawToken: string | null
  lineageUpdatedAt: Date
}

export type DirectoryCommandResult = {
  intermediary: FinooIntermediary
  requiresReactivation?: boolean
  warningCode?: 'access_notice_delivery_failed'
  deliveryFailed?: boolean
}

type TransactionOutcome = {
  intermediary: FinooIntermediary
  delivery?: EmailDeliveryPlan
  eventId?: FinooIntermediaryEventId
  additionalEventId?: FinooIntermediaryEventId
  invalidateCustomerUserId?: string
  requiresReactivation?: boolean
}

const invitationPermissions = [
  'finoo_intermediaries.manage',
  'customer_accounts.invite',
  'customer_accounts.manage',
] as const

function commandEntityManager(ctx: CommandRuntimeContext): EntityManager {
  return (ctx.container.resolve('em') as EntityManager).fork()
}

function requireStaffScope(ctx: CommandRuntimeContext): StaffDirectoryScope {
  const tenantId = ctx.auth?.tenantId ?? null
  const organizationId = ctx.selectedOrganizationId ?? ctx.auth?.orgId ?? null
  const actorUserId = ctx.auth?.userId ?? null
  if (
    !tenantId
    || !organizationId
    || !actorUserId
    || !z.string().uuid().safeParse(actorUserId).success
  ) {
    throw new CrudHttpError(400, {
      error: 'Scoped interactive staff context is required',
      code: 'interactive_actor_required',
    })
  }
  return { tenantId, organizationId, actorUserId }
}

async function requireStaffFeatures(
  ctx: CommandRuntimeContext,
  scope: StaffDirectoryScope,
  features: readonly string[],
): Promise<void> {
  const rbacService = ctx.container.resolve('rbacService') as RbacService
  const allowed = await rbacService.userHasAllFeatures(scope.actorUserId, [...features], {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
  })
  if (!allowed) throw new CrudHttpError(403, { error: 'Forbidden' })
}

async function enforceIntermediaryVersion(
  ctx: CommandRuntimeContext,
  intermediary: FinooIntermediary,
  expectedUpdatedAt: string,
): Promise<void> {
  await enforceCommandOptimisticLockWithGuards(ctx.container, {
    resourceKind: 'finoo_intermediaries.intermediary',
    resourceId: intermediary.id,
    current: intermediary.updatedAt,
    expected: expectedUpdatedAt,
    request: ctx.request,
  })
}

function cancelInvitation(invitation: CustomerUserInvitation | null, now: Date): void {
  if (!invitation) return
  if (invitation.acceptedAt) throw directoryConflict('invitation_already_accepted')
  invitation.cancelledAt = now
}

function applyInvitationPending(
  intermediary: FinooIntermediary,
  invitation: CustomerUserInvitation,
  actorUserId: string,
  now: Date,
): void {
  intermediary.invitationId = invitation.id
  intermediary.invitationExpiresAt = invitation.expiresAt
  intermediary.customerUserId = null
  intermediary.lifecycleState = 'delivery_failed'
  intermediary.lastEmailKind = 'invitation'
  intermediary.lastEmailStatus = 'pending'
  intermediary.lastEmailAttemptAt = null
  intermediary.lastEmailDeliveredAt = null
  intermediary.lastEmailErrorCode = null
  intermediary.deactivatedAt = null
  intermediary.updatedByUserId = actorUserId
  intermediary.updatedAt = now
}

function createDirectoryRecord(input: {
  scope: StaffDirectoryScope
  email: string
  firstName: string
  lastName: string
  now: Date
}): FinooIntermediary {
  const intermediary = new FinooIntermediary()
  intermediary.tenantId = input.scope.tenantId
  intermediary.organizationId = input.scope.organizationId
  intermediary.firstName = input.firstName
  intermediary.lastName = input.lastName
  intermediary.email = normalizeIntermediaryEmail(input.email)
  intermediary.emailHash = intermediaryEmailHash(input.email)
  intermediary.createdByUserId = input.scope.actorUserId
  intermediary.updatedByUserId = input.scope.actorUserId
  intermediary.createdAt = input.now
  intermediary.updatedAt = input.now
  return intermediary
}

async function prepareInvitation(
  em: EntityManager,
  invitationService: CustomerInvitationService,
  intermediary: FinooIntermediary,
  scope: StaffDirectoryScope,
  roleId: string,
  now: Date,
): Promise<EmailDeliveryPlan> {
  const currentInvitation = intermediary.invitationId
    ? await loadCurrentInvitation(em, intermediary.invitationId, scope, true)
    : null
  cancelInvitation(currentInvitation, now)
  if (currentInvitation) await em.flush()

  const { invitation, rawToken } = await invitationService.createInvitation(
    intermediary.email,
    scope,
    {
      roleIds: [roleId],
      invitedByUserId: scope.actorUserId,
      displayName: `${intermediary.firstName} ${intermediary.lastName}`,
    },
    em,
  )
  applyInvitationPending(intermediary, invitation, scope.actorUserId, now)
  await em.persist(intermediary).flush()
  return {
    kind: 'invitation',
    intermediaryId: intermediary.id,
    invitationId: invitation.id,
    email: intermediary.email,
    rawToken,
    lineageUpdatedAt: new Date(intermediary.updatedAt),
  }
}

async function reloadDirectory(
  em: EntityManager,
  intermediaryId: string,
  scope: IntermediaryDirectoryScope,
): Promise<FinooIntermediary> {
  em.clear()
  return loadDirectoryById(em, intermediaryId, scope)
}

async function finalizeEmailDelivery(
  ctx: CommandRuntimeContext,
  scope: IntermediaryDirectoryScope,
  plan: EmailDeliveryPlan,
): Promise<{ intermediary: FinooIntermediary; applied: boolean; failed: boolean }> {
  let failed = false
  try {
    if (plan.kind === 'invitation') {
      if (!plan.rawToken || !plan.invitationId) throw new Error('Invitation delivery plan is incomplete')
      await sendCustomerInvitationEmail({
        container: ctx.container as AppContainer,
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        email: plan.email,
        rawToken: plan.rawToken,
      })
    } else {
      await sendIntermediaryAccessNotice({
        container: ctx.container as AppContainer,
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        email: plan.email,
      })
    }
  } catch {
    failed = true
  }

  const em = commandEntityManager(ctx)
  const attemptedAt = new Date()
  const updates: Partial<FinooIntermediary> = {
    lastEmailAttemptAt: attemptedAt,
    lastEmailStatus: failed ? 'failed' : 'delivered',
    lastEmailDeliveredAt: failed ? null : attemptedAt,
    lastEmailErrorCode: failed ? 'email_delivery_failed' : null,
    updatedAt: attemptedAt,
  }
  if (plan.kind === 'invitation') updates.lifecycleState = failed ? 'delivery_failed' : 'invited'
  const affected = await em.nativeUpdate(
    FinooIntermediary,
    {
      id: plan.intermediaryId,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      invitationId: plan.invitationId,
      updatedAt: plan.lineageUpdatedAt,
      deletedAt: null,
    } as FilterQuery<FinooIntermediary>,
    updates,
  )
  const intermediary = await reloadDirectory(em, plan.intermediaryId, scope)
  return { intermediary, applied: affected === 1, failed }
}

async function emitDirectoryEvent(
  eventId: FinooIntermediaryEventId,
  intermediary: FinooIntermediary,
  actorUserId: string | null,
): Promise<void> {
  await emitFinooIntermediaryEvent(eventId, {
    id: intermediary.id,
    tenantId: intermediary.tenantId,
    organizationId: intermediary.organizationId,
    status: resolveEffectiveIntermediaryStatus(intermediary),
    actorUserId,
    invitationId: intermediary.invitationId ?? null,
    customerUserId: intermediary.customerUserId ?? null,
  }, { persistent: true })
}

export async function emitIntermediaryIndexUpsert(
  ctx: CommandRuntimeContext,
  intermediary: Pick<FinooIntermediary, 'id' | 'tenantId' | 'organizationId'>,
): Promise<void> {
  let eventBus: EventBus | null = null
  try {
    eventBus = ctx.container.resolve('eventBus') as EventBus
  } catch (error) {
    logger.warn('eventBus resolve failed; skipping intermediary query index upsert', {
      intermediaryId: intermediary.id,
      tenantId: intermediary.tenantId,
      organizationId: intermediary.organizationId,
      error,
    })
    return
  }

  await eventBus.emitEvent(
    'query_index.upsert_one',
    {
      entityType: INTERMEDIARY_ENTITY_TYPE,
      recordId: intermediary.id,
      tenantId: intermediary.tenantId,
      organizationId: intermediary.organizationId,
      crudAction: 'updated',
    },
    {
      tenantId: intermediary.tenantId,
      organizationId: intermediary.organizationId,
    },
  ).catch((error: unknown) => {
    logger.warn('Intermediary query index upsert failed', {
      intermediaryId: intermediary.id,
      tenantId: intermediary.tenantId,
      organizationId: intermediary.organizationId,
      error,
    })
  })
}

async function completeOutcome(
  ctx: CommandRuntimeContext,
  scope: StaffDirectoryScope,
  outcome: TransactionOutcome,
): Promise<DirectoryCommandResult> {
  if (outcome.invalidateCustomerUserId) {
    const customerRbacService = ctx.container.resolve('customerRbacService') as CustomerRbacService
    await customerRbacService.invalidateUserCache(outcome.invalidateCustomerUserId)
  }
  if (outcome.eventId) {
    await emitDirectoryEvent(outcome.eventId, outcome.intermediary, scope.actorUserId)
  }
  if (outcome.additionalEventId) {
    await emitDirectoryEvent(outcome.additionalEventId, outcome.intermediary, scope.actorUserId)
  }

  let intermediary = outcome.intermediary
  let deliveryFailed = false
  let deliveryApplied = false
  if (outcome.delivery) {
    const delivery = await finalizeEmailDelivery(ctx, scope, outcome.delivery)
    intermediary = delivery.intermediary
    deliveryFailed = delivery.failed && delivery.applied
    deliveryApplied = delivery.applied
  }

  if (outcome.delivery?.kind === 'invitation' && deliveryApplied) {
    await emitDirectoryEvent(
      deliveryFailed
        ? 'finoo_intermediaries.intermediary.invitation_delivery_failed'
        : 'finoo_intermediaries.intermediary.invited',
      intermediary,
      scope.actorUserId,
    )
  }
  await emitIntermediaryIndexUpsert(ctx, intermediary)

  return {
    intermediary,
    ...(outcome.requiresReactivation ? { requiresReactivation: true } : {}),
    ...(outcome.delivery?.kind === 'invitation' && deliveryFailed ? { deliveryFailed: true } : {}),
    ...(outcome.delivery?.kind === 'access_notice' && deliveryFailed
      ? { warningCode: 'access_notice_delivery_failed' as const }
      : {}),
  }
}

function piiSafeCommandLog(
  actionLabel: string,
  result: DirectoryCommandResult,
  redoInput: Record<string, unknown>,
  actorUserId: string | null,
) {
  return {
    actionLabel,
    resourceKind: 'finoo_intermediaries.intermediary',
    resourceId: result.intermediary.id,
    tenantId: result.intermediary.tenantId,
    organizationId: result.intermediary.organizationId,
    actorUserId,
    payload: { __redoInput: redoInput },
  }
}

export const inviteIntermediaryCommand: CommandHandler<unknown, DirectoryCommandResult> = {
  id: 'finoo_intermediaries.intermediary.invite',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const input = intermediaryInviteSchema.parse(rawInput)
    const scope = requireStaffScope(ctx)
    await requireStaffFeatures(ctx, scope, invitationPermissions)
    const em = commandEntityManager(ctx)
    const invitationService = ctx.container.resolve('customerInvitationService') as CustomerInvitationService
    try {
      const outcome = await em.transactional(async (operationEm): Promise<TransactionOutcome> => {
        const role = await loadIntermediaryRole(operationEm, scope)
        const existing = await loadDirectoryByEmail(operationEm, input.email, scope, true)
        if (existing) {
          if (existing.lifecycleState === 'active') throw directoryConflict('already_active')
          if (existing.lifecycleState === 'inactive') {
            return { intermediary: existing, requiresReactivation: true }
          }
          existing.firstName = input.firstName
          existing.lastName = input.lastName
          existing.email = normalizeIntermediaryEmail(input.email)
          existing.emailHash = intermediaryEmailHash(input.email)
          await operationEm.flush()
          const delivery = await prepareInvitation(
            operationEm,
            invitationService,
            existing,
            scope,
            role.id,
            new Date(),
          )
          return { intermediary: existing, delivery, eventId: 'finoo_intermediaries.intermediary.updated' }
        }

        const user = await loadScopedCustomerUserByEmail(operationEm, input.email, scope, true)
        const now = new Date()
        const intermediary = createDirectoryRecord({ ...input, scope, now })
        if (user) {
          intermediary.customerUserId = user.id
          intermediary.email = user.email
          intermediary.emailHash = user.emailHash
          if (!user.isActive) {
            intermediary.lifecycleState = 'inactive'
            intermediary.deactivatedAt = now
            await operationEm.persist(intermediary).flush()
            return {
              intermediary,
              requiresReactivation: true,
              eventId: 'finoo_intermediaries.intermediary.updated',
            }
          }
          const membership = await restoreIntermediaryMembership(operationEm, user, role)
          intermediary.lifecycleState = 'active'
          intermediary.activatedAt = now
          intermediary.lastEmailKind = 'access_notice'
          intermediary.lastEmailStatus = 'pending'
          await operationEm.persist(intermediary).flush()
          return {
            intermediary,
            invalidateCustomerUserId: membership.changed ? user.id : undefined,
            eventId: 'finoo_intermediaries.intermediary.activated',
            delivery: {
              kind: 'access_notice',
              intermediaryId: intermediary.id,
              invitationId: null,
              email: intermediary.email,
              rawToken: null,
              lineageUpdatedAt: new Date(intermediary.updatedAt),
            },
          }
        }

        const delivery = await prepareInvitation(
          operationEm,
          invitationService,
          intermediary,
          scope,
          role.id,
          now,
        )
        return { intermediary, delivery }
      })
      return completeOutcome(ctx, scope, outcome)
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException) {
        throw directoryConflict('duplicate_intermediary')
      }
      throw error
    }
  },
  buildLog({ result, ctx }) {
    return piiSafeCommandLog('Invite intermediary', result, {}, ctx.auth?.userId ?? null)
  },
}

export const updateIntermediaryCommand: CommandHandler<unknown, DirectoryCommandResult> = {
  id: 'finoo_intermediaries.intermediary.update',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const input = updateCommandSchema.parse(rawInput)
    const scope = requireStaffScope(ctx)
    await requireStaffFeatures(ctx, scope, ['finoo_intermediaries.manage'])
    const em = commandEntityManager(ctx)
    const invitationService = ctx.container.resolve('customerInvitationService') as CustomerInvitationService
    const outcome = await em.transactional(async (operationEm): Promise<TransactionOutcome> => {
      const intermediary = await loadDirectoryById(operationEm, input.intermediaryId, scope, true)
      await enforceIntermediaryVersion(ctx, intermediary, input.expectedUpdatedAt)
      const lockedInvitation = !intermediary.customerUserId && intermediary.invitationId
        ? await loadCurrentInvitation(operationEm, intermediary.invitationId, scope, true)
        : null
      const normalizedEmail = input.email ? normalizeIntermediaryEmail(input.email) : intermediary.email
      const emailChanged = normalizedEmail !== normalizeIntermediaryEmail(intermediary.email)
      let targetUser: CustomerUser | null = null
      if (emailChanged && intermediary.customerUserId) throw directoryConflict('email_immutable_after_link')
      if (emailChanged) {
        await requireStaffFeatures(ctx, scope, invitationPermissions)
        const duplicate = await loadDirectoryByEmail(operationEm, normalizedEmail, scope, true)
        if (duplicate && duplicate.id !== intermediary.id) throw directoryConflict('duplicate_intermediary')
        targetUser = await loadScopedCustomerUserByEmail(operationEm, normalizedEmail, scope, true)
      }

      if (emailChanged && intermediary.lifecycleState !== 'inactive') {
        const role = await loadIntermediaryRole(operationEm, scope)
        if (targetUser) {
          const now = new Date()
          cancelInvitation(lockedInvitation, now)
          if (lockedInvitation) await operationEm.flush()
          if (!targetUser.isActive) {
            intermediary.firstName = input.firstName
            intermediary.lastName = input.lastName
            intermediary.email = targetUser.email
            intermediary.emailHash = targetUser.emailHash
            intermediary.customerUserId = targetUser.id
            intermediary.invitationId = null
            intermediary.invitationExpiresAt = null
            intermediary.lifecycleState = 'inactive'
            intermediary.deactivatedAt = now
            intermediary.updatedByUserId = scope.actorUserId
            intermediary.updatedAt = now
            await operationEm.flush()
            return {
              intermediary,
              requiresReactivation: true,
              eventId: 'finoo_intermediaries.intermediary.updated',
            }
          }

          const membership = await restoreIntermediaryMembership(operationEm, targetUser, role)
          intermediary.firstName = input.firstName
          intermediary.lastName = input.lastName
          intermediary.email = targetUser.email
          intermediary.emailHash = targetUser.emailHash
          intermediary.customerUserId = targetUser.id
          intermediary.invitationId = null
          intermediary.invitationExpiresAt = null
          intermediary.lifecycleState = 'active'
          intermediary.activatedAt = now
          intermediary.deactivatedAt = null
          intermediary.lastEmailKind = 'access_notice'
          intermediary.lastEmailStatus = 'pending'
          intermediary.lastEmailAttemptAt = null
          intermediary.lastEmailDeliveredAt = null
          intermediary.lastEmailErrorCode = null
          intermediary.updatedByUserId = scope.actorUserId
          intermediary.updatedAt = now
          await operationEm.flush()
          return {
            intermediary,
            invalidateCustomerUserId: membership.changed ? targetUser.id : undefined,
            eventId: 'finoo_intermediaries.intermediary.updated',
            additionalEventId: 'finoo_intermediaries.intermediary.activated',
            delivery: {
              kind: 'access_notice',
              intermediaryId: intermediary.id,
              invitationId: null,
              email: intermediary.email,
              rawToken: null,
              lineageUpdatedAt: new Date(intermediary.updatedAt),
            },
          }
        }

        intermediary.firstName = input.firstName
        intermediary.lastName = input.lastName
        intermediary.email = normalizedEmail
        intermediary.emailHash = intermediaryEmailHash(normalizedEmail)
        await operationEm.flush()
        const delivery = await prepareInvitation(
          operationEm,
          invitationService,
          intermediary,
          scope,
          role.id,
          new Date(),
        )
        return { intermediary, delivery, eventId: 'finoo_intermediaries.intermediary.updated' }
      }

      intermediary.firstName = input.firstName
      intermediary.lastName = input.lastName
      if (emailChanged) {
        intermediary.email = normalizedEmail
        intermediary.emailHash = intermediaryEmailHash(normalizedEmail)
        cancelInvitation(lockedInvitation, new Date())
        intermediary.invitationId = null
        intermediary.invitationExpiresAt = null
      }
      intermediary.updatedByUserId = scope.actorUserId
      intermediary.updatedAt = new Date()
      await operationEm.flush()
      return { intermediary, eventId: 'finoo_intermediaries.intermediary.updated' }
    })
    return completeOutcome(ctx, scope, outcome)
  },
  buildLog({ input, result, ctx }) {
    const parsed = updateCommandSchema.parse(input)
    return piiSafeCommandLog('Update intermediary', result, {
      intermediaryId: parsed.intermediaryId,
      expectedUpdatedAt: parsed.expectedUpdatedAt,
    }, ctx.auth?.userId ?? null)
  },
}

export const resendIntermediaryInvitationCommand: CommandHandler<unknown, DirectoryCommandResult> = {
  id: 'finoo_intermediaries.invitation.resend',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const input = lifecycleCommandSchema.parse(rawInput)
    const scope = requireStaffScope(ctx)
    await requireStaffFeatures(ctx, scope, invitationPermissions)
    const em = commandEntityManager(ctx)
    const invitationService = ctx.container.resolve('customerInvitationService') as CustomerInvitationService
    const outcome = await em.transactional(async (operationEm): Promise<TransactionOutcome> => {
      const intermediary = await loadDirectoryById(operationEm, input.intermediaryId, scope, true)
      await enforceIntermediaryVersion(ctx, intermediary, input.expectedUpdatedAt)
      if (intermediary.customerUserId || !['delivery_failed', 'invited'].includes(intermediary.lifecycleState)) {
        throw directoryConflict('illegal_resend_transition')
      }
      const role = await loadIntermediaryRole(operationEm, scope)
      const delivery = await prepareInvitation(
        operationEm,
        invitationService,
        intermediary,
        scope,
        role.id,
        new Date(),
      )
      return { intermediary, delivery }
    })
    return completeOutcome(ctx, scope, outcome)
  },
  buildLog({ input, result, ctx }) {
    const parsed = lifecycleCommandSchema.parse(input)
    return piiSafeCommandLog('Resend intermediary invitation', result, parsed, ctx.auth?.userId ?? null)
  },
}

export const cancelIntermediaryInvitationCommand: CommandHandler<unknown, DirectoryCommandResult> = {
  id: 'finoo_intermediaries.invitation.cancel',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const input = lifecycleCommandSchema.parse(rawInput)
    const scope = requireStaffScope(ctx)
    await requireStaffFeatures(ctx, scope, invitationPermissions)
    const em = commandEntityManager(ctx)
    const outcome = await em.transactional(async (operationEm): Promise<TransactionOutcome> => {
      const intermediary = await loadDirectoryById(operationEm, input.intermediaryId, scope, true)
      await enforceIntermediaryVersion(ctx, intermediary, input.expectedUpdatedAt)
      if (intermediary.customerUserId || !['delivery_failed', 'invited'].includes(intermediary.lifecycleState)) {
        throw directoryConflict('illegal_cancel_transition')
      }
      const invitation = intermediary.invitationId
        ? await loadCurrentInvitation(operationEm, intermediary.invitationId, scope, true)
        : null
      const now = new Date()
      cancelInvitation(invitation, now)
      intermediary.lifecycleState = 'inactive'
      intermediary.invitationExpiresAt = null
      intermediary.lastEmailStatus = invitation ? intermediary.lastEmailStatus : null
      intermediary.deactivatedAt = now
      intermediary.updatedByUserId = scope.actorUserId
      intermediary.updatedAt = now
      await operationEm.flush()
      return { intermediary, eventId: 'finoo_intermediaries.intermediary.invitation_cancelled' }
    })
    return completeOutcome(ctx, scope, outcome)
  },
  buildLog({ input, result, ctx }) {
    const parsed = lifecycleCommandSchema.parse(input)
    return piiSafeCommandLog('Cancel intermediary invitation', result, parsed, ctx.auth?.userId ?? null)
  },
}

export const activateIntermediaryFromInvitationCommand: CommandHandler<unknown, DirectoryCommandResult> = {
  id: 'finoo_intermediaries.intermediary.activate_from_invitation',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const input = activateFromInvitationSchema.parse(rawInput)
    if (!ctx.systemActor) throw new CrudHttpError(403, { error: 'Forbidden' })
    const em = commandEntityManager(ctx)
    const invitationCandidate = await findOneWithDecryption(
      em,
      CustomerUserInvitation,
      { id: input.invitationId, tenantId: input.tenantId } as FilterQuery<CustomerUserInvitation>,
    )
    if (!invitationCandidate) throw directoryNotFound()
    const scope = {
      tenantId: input.tenantId,
      organizationId: invitationCandidate.organizationId,
    }
    const outcome = await em.transactional(async (operationEm): Promise<TransactionOutcome> => {
      const intermediary = await findOneWithDecryption(
        operationEm,
        FinooIntermediary,
        {
          tenantId: scope.tenantId,
          organizationId: scope.organizationId,
          invitationId: input.invitationId,
          deletedAt: null,
        } as FilterQuery<FinooIntermediary>,
        { lockMode: LockMode.PESSIMISTIC_WRITE },
        scope,
      )
      if (!intermediary) throw directoryNotFound()
      const invitation = await findOneWithDecryption(
        operationEm,
        CustomerUserInvitation,
        {
          id: input.invitationId,
          tenantId: scope.tenantId,
          organizationId: scope.organizationId,
        } as FilterQuery<CustomerUserInvitation>,
        { lockMode: LockMode.PESSIMISTIC_WRITE },
        scope,
      )
      if (!invitation || !invitation.acceptedAt || invitation.cancelledAt) throw directoryNotFound()
      const user = await loadScopedCustomerUser(operationEm, input.userId, scope, true)
      const role = await loadIntermediaryRole(operationEm, scope)
      const membership = await loadIntermediaryMembership(operationEm, user, role, true)
      const invitationRoleIds = Array.isArray(invitation.roleIdsJson) ? invitation.roleIdsJson : []
      const expectedHashes = lookupHashCandidates(invitation.email)
      if (
        !user.isActive
        || !membership
        || membership.deletedAt
        || !invitationRoleIds.includes(role.id)
        || !expectedHashes.includes(user.emailHash)
        || !expectedHashes.includes(intermediary.emailHash)
      ) {
        throw directoryConflict('invitation_scope_mismatch')
      }
      if (intermediary.lifecycleState === 'active') {
        if (intermediary.customerUserId !== user.id) throw directoryConflict('activation_lineage_mismatch')
        return { intermediary }
      }
      if (!['delivery_failed', 'invited'].includes(intermediary.lifecycleState)) {
        throw directoryConflict('illegal_activation_transition')
      }
      const now = new Date()
      intermediary.customerUserId = user.id
      intermediary.lifecycleState = 'active'
      intermediary.activatedAt = now
      intermediary.deactivatedAt = null
      intermediary.updatedByUserId = null
      intermediary.updatedAt = now
      await operationEm.flush()
      return {
        intermediary,
        invalidateCustomerUserId: user.id,
        eventId: 'finoo_intermediaries.intermediary.activated',
      }
    })
    if (outcome.invalidateCustomerUserId) {
      const customerRbacService = ctx.container.resolve('customerRbacService') as CustomerRbacService
      await customerRbacService.invalidateUserCache(outcome.invalidateCustomerUserId)
    }
    if (outcome.eventId) await emitDirectoryEvent(outcome.eventId, outcome.intermediary, null)
    await emitIntermediaryIndexUpsert(ctx, outcome.intermediary)
    return { intermediary: outcome.intermediary }
  },
  buildLog({ input, result }) {
    const parsed = activateFromInvitationSchema.parse(input)
    return piiSafeCommandLog('Activate intermediary from invitation', result, parsed, null)
  },
}

export const deactivateIntermediaryCommand: CommandHandler<unknown, DirectoryCommandResult> = {
  id: 'finoo_intermediaries.intermediary.deactivate',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const input = lifecycleCommandSchema.parse(rawInput)
    const scope = requireStaffScope(ctx)
    await requireStaffFeatures(ctx, scope, ['finoo_intermediaries.manage', 'customer_accounts.manage'])
    const em = commandEntityManager(ctx)
    const outcome = await em.transactional(async (operationEm): Promise<TransactionOutcome> => {
      const intermediary = await loadDirectoryById(operationEm, input.intermediaryId, scope, true)
      await enforceIntermediaryVersion(ctx, intermediary, input.expectedUpdatedAt)
      if (intermediary.lifecycleState !== 'active' || !intermediary.customerUserId) {
        throw directoryConflict('illegal_deactivate_transition')
      }
      const user = await loadScopedCustomerUser(operationEm, intermediary.customerUserId, scope, true)
      const role = await loadIntermediaryRole(operationEm, scope)
      const membership = await loadIntermediaryMembership(operationEm, user, role, true)
      if (!membership || membership.deletedAt) throw directoryConflict('intermediary_membership_missing')
      const sessions = await lockActiveUserSessions(operationEm, user, scope)
      const now = new Date()
      user.isActive = false
      user.sessionsRevokedAt = now
      membership.deletedAt = now
      for (const session of sessions) session.deletedAt = now
      intermediary.lifecycleState = 'inactive'
      intermediary.deactivatedAt = now
      intermediary.updatedByUserId = scope.actorUserId
      intermediary.updatedAt = now
      await operationEm.flush()
      return {
        intermediary,
        invalidateCustomerUserId: user.id,
        eventId: 'finoo_intermediaries.intermediary.deactivated',
      }
    })
    return completeOutcome(ctx, scope, outcome)
  },
  buildLog({ input, result, ctx }) {
    const parsed = lifecycleCommandSchema.parse(input)
    return piiSafeCommandLog('Deactivate intermediary', result, parsed, ctx.auth?.userId ?? null)
  },
}

export const reactivateIntermediaryCommand: CommandHandler<unknown, DirectoryCommandResult> = {
  id: 'finoo_intermediaries.intermediary.reactivate',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const input = lifecycleCommandSchema.parse(rawInput)
    const scope = requireStaffScope(ctx)
    await requireStaffFeatures(ctx, scope, ['finoo_intermediaries.manage', 'customer_accounts.manage'])
    const em = commandEntityManager(ctx)
    const invitationService = ctx.container.resolve('customerInvitationService') as CustomerInvitationService
    const outcome = await em.transactional(async (operationEm): Promise<TransactionOutcome> => {
      const intermediary = await loadDirectoryById(operationEm, input.intermediaryId, scope, true)
      await enforceIntermediaryVersion(ctx, intermediary, input.expectedUpdatedAt)
      if (intermediary.lifecycleState !== 'inactive') throw directoryConflict('illegal_reactivate_transition')
      const role = await loadIntermediaryRole(operationEm, scope)
      const user = intermediary.customerUserId
        ? await loadScopedCustomerUser(operationEm, intermediary.customerUserId, scope, true)
        : await loadScopedCustomerUserByEmail(operationEm, intermediary.email, scope, true)
      if (!user) {
        await requireStaffFeatures(ctx, scope, invitationPermissions)
        const delivery = await prepareInvitation(
          operationEm,
          invitationService,
          intermediary,
          scope,
          role.id,
          new Date(),
        )
        return { intermediary, delivery, eventId: 'finoo_intermediaries.intermediary.reactivated' }
      }

      await restoreIntermediaryMembership(operationEm, user, role)
      const now = new Date()
      user.isActive = true
      intermediary.customerUserId = user.id
      intermediary.invitationId = null
      intermediary.invitationExpiresAt = null
      intermediary.lifecycleState = 'active'
      intermediary.activatedAt = now
      intermediary.deactivatedAt = null
      intermediary.lastEmailKind = 'access_notice'
      intermediary.lastEmailStatus = 'pending'
      intermediary.lastEmailAttemptAt = null
      intermediary.lastEmailDeliveredAt = null
      intermediary.lastEmailErrorCode = null
      intermediary.updatedByUserId = scope.actorUserId
      intermediary.updatedAt = now
      await operationEm.flush()
      return {
        intermediary,
        invalidateCustomerUserId: user.id,
        eventId: 'finoo_intermediaries.intermediary.reactivated',
        delivery: {
          kind: 'access_notice',
          intermediaryId: intermediary.id,
          invitationId: null,
          email: intermediary.email,
          rawToken: null,
          lineageUpdatedAt: new Date(intermediary.updatedAt),
        },
      }
    })
    return completeOutcome(ctx, scope, outcome)
  },
  buildLog({ input, result, ctx }) {
    const parsed = lifecycleCommandSchema.parse(input)
    return piiSafeCommandLog('Reactivate intermediary', result, parsed, ctx.auth?.userId ?? null)
  },
}

registerCommand(inviteIntermediaryCommand)
registerCommand(updateIntermediaryCommand)
registerCommand(resendIntermediaryInvitationCommand)
registerCommand(cancelIntermediaryInvitationCommand)
registerCommand(activateIntermediaryFromInvitationCommand)
registerCommand(deactivateIntermediaryCommand)
registerCommand(reactivateIntermediaryCommand)
