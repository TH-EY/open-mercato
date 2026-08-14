import { LockMode, UniqueConstraintViolationException } from '@mikro-orm/core'
import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import { z } from 'zod'
import type { RbacService } from '@open-mercato/core/modules/auth/services/rbacService'
import type { CustomerRbacService } from '@open-mercato/core/modules/customer_accounts/services/customerRbacService'
import {
  registerCommand,
  type CommandHandler,
  type CommandRuntimeContext,
} from '@open-mercato/shared/lib/commands'
import { extractUndoPayload, type UndoPayload } from '@open-mercato/shared/lib/commands/undo'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { enforceCommandOptimisticLockWithGuards } from '@open-mercato/shared/lib/crud/optimistic-lock-command'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import {
  assignmentCreateSchema,
  assignmentDeleteSchema,
  assignmentUpdateSchema,
  noteCreateSchema,
  noteDeleteSchema,
  noteUpdateSchema,
} from '../data/validators'
import {
  FinooIntermediaryAssignment,
  FinooIntermediaryNote,
} from '../data/entities'
import {
  assertPortalAssignmentAccess,
  assertAssignmentStillEligible,
  loadAssignableIntermediary,
  loadEligibleDeal,
} from '../lib/access'
import { isLegalPartnerStatusTransition } from '../lib/domain'

const assignmentIdSchema = z.object({ assignmentId: z.string().uuid() })
const noteIdSchema = assignmentIdSchema.extend({ noteId: z.string().uuid() })

const assignmentUpdateCommandSchema = assignmentIdSchema.merge(assignmentUpdateSchema)
const assignmentDeleteCommandSchema = assignmentIdSchema.merge(assignmentDeleteSchema)
const partnerStatusCommandSchema = assignmentIdSchema.extend({
  partnerStatus: z.enum(['new', 'in_progress', 'done']),
  expectedUpdatedAt: z.string().datetime({ offset: true }),
})
const noteCreateCommandSchema = assignmentIdSchema.merge(noteCreateSchema)
const noteUpdateCommandSchema = noteIdSchema.merge(noteUpdateSchema)
const noteDeleteCommandSchema = noteIdSchema.merge(noteDeleteSchema)

type AssignmentSnapshot = {
  id: string
  tenantId: string
  organizationId: string
  dealId: string
  intermediaryCustomerUserId: string
  intermediaryRoleId: string
  eligibleStageId: string
  partnerStatus: FinooIntermediaryAssignment['partnerStatus']
  assignedByUserId: string
  statusUpdatedByCustomerUserId: string | null
  statusUpdatedAt: string | null
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

type NoteSnapshot = {
  id: string
  tenantId: string
  organizationId: string
  assignmentId: string
  authorCustomerUserId: string
  body: string
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

function commandEntityManager(ctx: CommandRuntimeContext): EntityManager {
  return ctx.transactionalEm ?? (ctx.container.resolve('em') as EntityManager)
}

async function inCommandTransaction<TResult>(
  ctx: CommandRuntimeContext,
  run: (em: EntityManager) => Promise<TResult>,
): Promise<TResult> {
  if (ctx.transactionalEm) return run(ctx.transactionalEm)
  return commandEntityManager(ctx).transactional(run)
}

function requireScope(ctx: CommandRuntimeContext) {
  const tenantId = ctx.auth?.tenantId ?? null
  const organizationId = ctx.selectedOrganizationId ?? ctx.auth?.orgId ?? null
  const actorId = ctx.auth?.sub ?? null
  if (!tenantId || !organizationId || !actorId) {
    throw new CrudHttpError(400, { error: 'Scoped authenticated context is required' })
  }
  return { tenantId, organizationId, actorId }
}

function assignmentWhere(id: string, tenantId: string, organizationId: string) {
  return { id, tenantId, organizationId, deletedAt: null } as FilterQuery<FinooIntermediaryAssignment>
}

function noteWhere(id: string, tenantId: string, organizationId: string) {
  return { id, tenantId, organizationId, deletedAt: null } as FilterQuery<FinooIntermediaryNote>
}

function notFound(): CrudHttpError {
  return new CrudHttpError(404, { error: 'Resource not found' })
}

function assignmentSnapshot(entity: FinooIntermediaryAssignment): AssignmentSnapshot {
  return {
    id: entity.id,
    tenantId: entity.tenantId,
    organizationId: entity.organizationId,
    dealId: entity.dealId,
    intermediaryCustomerUserId: entity.intermediaryCustomerUserId,
    intermediaryRoleId: entity.intermediaryRoleId,
    eligibleStageId: entity.eligibleStageId,
    partnerStatus: entity.partnerStatus,
    assignedByUserId: entity.assignedByUserId,
    statusUpdatedByCustomerUserId: entity.statusUpdatedByCustomerUserId ?? null,
    statusUpdatedAt: entity.statusUpdatedAt?.toISOString() ?? null,
    createdAt: entity.createdAt.toISOString(),
    updatedAt: entity.updatedAt.toISOString(),
    deletedAt: entity.deletedAt?.toISOString() ?? null,
  }
}

function noteSnapshot(entity: FinooIntermediaryNote): NoteSnapshot {
  return {
    id: entity.id,
    tenantId: entity.tenantId,
    organizationId: entity.organizationId,
    assignmentId: entity.assignment.id,
    authorCustomerUserId: entity.authorCustomerUserId,
    body: entity.body,
    createdAt: entity.createdAt.toISOString(),
    updatedAt: entity.updatedAt.toISOString(),
    deletedAt: entity.deletedAt?.toISOString() ?? null,
  }
}

async function requireAssignment(
  em: EntityManager,
  id: string,
  tenantId: string,
  organizationId: string,
  lock = false,
) {
  const assignment = await em.findOne(
    FinooIntermediaryAssignment,
    assignmentWhere(id, tenantId, organizationId),
    lock ? { lockMode: LockMode.PESSIMISTIC_WRITE } : undefined,
  )
  if (!assignment) throw notFound()
  return assignment
}

async function requireEligibleAssignmentForMutation(
  em: EntityManager,
  id: string,
  tenantId: string,
  organizationId: string,
  maskIneligible = false,
) {
  const candidate = await requireAssignment(em, id, tenantId, organizationId)
  await assertAssignmentStillEligible(em, candidate, { lock: true, maskIneligible })
  const assignment = await requireAssignment(em, id, tenantId, organizationId, true)
  if (
    assignment.dealId !== candidate.dealId
    || assignment.eligibleStageId !== candidate.eligibleStageId
  ) {
    throw notFound()
  }
  return assignment
}

async function requirePortalAssignment(
  em: EntityManager,
  id: string,
  scope: ReturnType<typeof requireScope>,
  lock = false,
) {
  const assignment = lock
    ? await requireEligibleAssignmentForMutation(em, id, scope.tenantId, scope.organizationId, true)
    : await requireAssignment(em, id, scope.tenantId, scope.organizationId)
  await assertPortalAssignmentAccess(em, assignment, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    customerUserId: scope.actorId,
  })
  return assignment
}

async function requirePortalNote(
  em: EntityManager,
  noteId: string,
  assignment: FinooIntermediaryAssignment,
  scope: ReturnType<typeof requireScope>,
  lock = false,
) {
  const note = await findOneWithDecryption(
    em,
    FinooIntermediaryNote,
    noteWhere(noteId, scope.tenantId, scope.organizationId),
    { populate: ['assignment'], ...(lock ? { lockMode: LockMode.PESSIMISTIC_WRITE } : {}) },
    { tenantId: scope.tenantId, organizationId: scope.organizationId },
  )
  if (
    !note
    || note.assignment.id !== assignment.id
    || note.authorCustomerUserId !== scope.actorId
  ) {
    throw notFound()
  }
  return note
}

async function requireStaffUndoAccess(
  ctx: CommandRuntimeContext,
  snapshot: Pick<AssignmentSnapshot | NoteSnapshot, 'tenantId' | 'organizationId'>,
): Promise<void> {
  const scope = requireScope(ctx)
  if (scope.tenantId !== snapshot.tenantId || scope.organizationId !== snapshot.organizationId) {
    throw notFound()
  }
  const rbacService = ctx.container.resolve('rbacService') as RbacService
  const allowed = await rbacService.userHasAllFeatures(
    scope.actorId,
    ['finoo_intermediaries.manage'],
    { tenantId: scope.tenantId, organizationId: scope.organizationId },
  )
  if (!allowed) throw new CrudHttpError(403, { error: 'Forbidden' })
}

async function requireStaffCommandAccess(ctx: CommandRuntimeContext): Promise<void> {
  const scope = requireScope(ctx)
  const rbacService = ctx.container.resolve('rbacService') as RbacService
  const allowed = await rbacService.userHasAllFeatures(
    scope.actorId,
    ['finoo_intermediaries.manage'],
    { tenantId: scope.tenantId, organizationId: scope.organizationId },
  )
  if (!allowed) throw new CrudHttpError(403, { error: 'Forbidden' })
}

async function requirePortalCommandAccess(ctx: CommandRuntimeContext): Promise<void> {
  const scope = requireScope(ctx)
  const customerRbacService = ctx.container.resolve('customerRbacService') as CustomerRbacService
  const allowed = await customerRbacService.userHasAllFeatures(
    scope.actorId,
    ['portal.finoo_intermediaries.view'],
    { tenantId: scope.tenantId, organizationId: scope.organizationId },
  )
  if (!allowed) throw new CrudHttpError(403, { error: 'Forbidden' })
}

async function requirePortalSnapshotAccess(
  ctx: CommandRuntimeContext,
  em: EntityManager,
  assignmentId: string,
  snapshot: Pick<AssignmentSnapshot | NoteSnapshot, 'tenantId' | 'organizationId'>,
  customerUserId: string,
): Promise<FinooIntermediaryAssignment> {
  const assignment = await requireEligibleAssignmentForMutation(
    em,
    assignmentId,
    snapshot.tenantId,
    snapshot.organizationId,
    true,
  )
  await assertPortalAssignmentAccess(em, assignment, {
    tenantId: snapshot.tenantId,
    organizationId: snapshot.organizationId,
    customerUserId,
  })
  const customerRbacService = ctx.container.resolve('customerRbacService') as CustomerRbacService
  const allowed = await customerRbacService.userHasAllFeatures(
    customerUserId,
    ['portal.finoo_intermediaries.view'],
    { tenantId: snapshot.tenantId, organizationId: snapshot.organizationId },
  )
  if (!allowed) throw new CrudHttpError(403, { error: 'Forbidden' })
  return assignment
}

function noteAuditSnapshot(snapshot: NoteSnapshot | null | undefined) {
  return snapshot ? { ...snapshot, body: '[REDACTED]' } : snapshot
}

function noteUndoPayload(logEntry: Parameters<NonNullable<CommandHandler['undo']>>[0]['logEntry']) {
  return extractUndoPayload<UndoPayload<NoteSnapshot>>(logEntry)
}

export const createAssignmentCommand: CommandHandler<unknown, FinooIntermediaryAssignment> = {
  id: 'finoo_intermediaries.assignment.create',
  isUndoable: true,
  async execute(rawInput, ctx) {
    const input = assignmentCreateSchema.parse(rawInput)
    const scope = requireScope(ctx)
    await requireStaffCommandAccess(ctx)
    try {
      return await inCommandTransaction(ctx, async (em) => {
        const { stage } = await loadEligibleDeal(em, { ...scope, dealId: input.dealId }, true)
        const existing = await em.findOne(FinooIntermediaryAssignment, {
          tenantId: scope.tenantId,
          organizationId: scope.organizationId,
          dealId: input.dealId,
          deletedAt: null,
        } as FilterQuery<FinooIntermediaryAssignment>)
        if (existing) {
          throw new CrudHttpError(409, { error: 'Deal already has an active assignment', code: 'assignment_exists' })
        }

        const { role } = await loadAssignableIntermediary(em, {
          ...scope,
          customerUserId: input.intermediaryCustomerUserId,
        })
        const assignment = em.create(FinooIntermediaryAssignment, {
          tenantId: scope.tenantId,
          organizationId: scope.organizationId,
          dealId: input.dealId,
          intermediaryCustomerUserId: input.intermediaryCustomerUserId,
          intermediaryRoleId: role.id,
          eligibleStageId: stage.id,
          partnerStatus: 'new',
          assignedByUserId: scope.actorId,
        })
        await em.persist(assignment).flush()
        return assignment
      })
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException) {
        throw new CrudHttpError(409, { error: 'Deal already has an active assignment', code: 'assignment_exists' })
      }
      throw error
    }
  },
  captureAfter: (_input, result) => assignmentSnapshot(result),
  async undo({ logEntry, ctx }) {
    const snapshot = logEntry.snapshotAfter as AssignmentSnapshot | null
    if (!snapshot) throw new Error('Missing assignment snapshot for undo')
    await requireStaffUndoAccess(ctx, snapshot)
    await inCommandTransaction(ctx, async (em) => {
      const assignment = await requireEligibleAssignmentForMutation(
        em,
        snapshot.id,
        snapshot.tenantId,
        snapshot.organizationId,
      )
      if (assignment.updatedAt.toISOString() !== snapshot.updatedAt) {
        throw new CrudHttpError(409, { error: 'Assignment changed after creation' })
      }
      await assertPortalAssignmentAccess(em, assignment, {
        tenantId: snapshot.tenantId,
        organizationId: snapshot.organizationId,
        customerUserId: snapshot.intermediaryCustomerUserId,
      })
      assignment.deletedAt = new Date()
      assignment.updatedAt = new Date()
      await em.flush()
    })
  },
}

export const updateAssignmentCommand: CommandHandler<unknown, FinooIntermediaryAssignment> = {
  id: 'finoo_intermediaries.assignment.update',
  isUndoable: true,
  async prepare(rawInput, ctx) {
    const input = assignmentUpdateCommandSchema.parse(rawInput)
    const scope = requireScope(ctx)
    const assignment = await requireAssignment(commandEntityManager(ctx), input.assignmentId, scope.tenantId, scope.organizationId)
    return { before: assignmentSnapshot(assignment) }
  },
  async execute(rawInput, ctx) {
    const input = assignmentUpdateCommandSchema.parse(rawInput)
    const scope = requireScope(ctx)
    await requireStaffCommandAccess(ctx)
    return inCommandTransaction(ctx, async (em) => {
      const assignment = await requireEligibleAssignmentForMutation(
        em,
        input.assignmentId,
        scope.tenantId,
        scope.organizationId,
      )
      await enforceCommandOptimisticLockWithGuards(ctx.container, {
        resourceKind: 'finoo_intermediaries.assignment',
        resourceId: assignment.id,
        current: assignment.updatedAt,
        expected: input.expectedUpdatedAt,
        request: ctx.request,
      })
      const { role } = await loadAssignableIntermediary(em, {
        ...scope,
        customerUserId: input.intermediaryCustomerUserId,
      })
      assignment.intermediaryCustomerUserId = input.intermediaryCustomerUserId
      assignment.intermediaryRoleId = role.id
      assignment.updatedAt = new Date()
      await em.flush()
      return assignment
    })
  },
  captureAfter: (_input, result) => assignmentSnapshot(result),
  async undo({ logEntry, ctx }) {
    const before = logEntry.snapshotBefore as AssignmentSnapshot | null
    const after = logEntry.snapshotAfter as AssignmentSnapshot | null
    if (!before || !after) throw new Error('Missing assignment snapshots for undo')
    await requireStaffUndoAccess(ctx, before)
    await inCommandTransaction(ctx, async (em) => {
      const assignment = await requireEligibleAssignmentForMutation(
        em,
        after.id,
        after.tenantId,
        after.organizationId,
      )
      if (assignment.updatedAt.toISOString() !== after.updatedAt) {
        throw new CrudHttpError(409, { error: 'Assignment changed after update' })
      }
      await assertPortalAssignmentAccess(em, assignment, {
        tenantId: after.tenantId,
        organizationId: after.organizationId,
        customerUserId: after.intermediaryCustomerUserId,
      })
      const { role } = await loadAssignableIntermediary(em, {
        tenantId: before.tenantId,
        organizationId: before.organizationId,
        customerUserId: before.intermediaryCustomerUserId,
      })
      if (role.id !== before.intermediaryRoleId) throw notFound()
      assignment.intermediaryCustomerUserId = before.intermediaryCustomerUserId
      assignment.intermediaryRoleId = before.intermediaryRoleId
      assignment.updatedAt = new Date()
      await em.flush()
    })
  },
}

export const deleteAssignmentCommand: CommandHandler<unknown, FinooIntermediaryAssignment> = {
  id: 'finoo_intermediaries.assignment.delete',
  isUndoable: true,
  async prepare(rawInput, ctx) {
    const input = assignmentDeleteCommandSchema.parse(rawInput)
    const scope = requireScope(ctx)
    const assignment = await requireAssignment(commandEntityManager(ctx), input.assignmentId, scope.tenantId, scope.organizationId)
    return { before: assignmentSnapshot(assignment) }
  },
  async execute(rawInput, ctx) {
    const input = assignmentDeleteCommandSchema.parse(rawInput)
    const scope = requireScope(ctx)
    await requireStaffCommandAccess(ctx)
    return inCommandTransaction(ctx, async (em) => {
      const assignment = await requireEligibleAssignmentForMutation(
        em,
        input.assignmentId,
        scope.tenantId,
        scope.organizationId,
      )
      await enforceCommandOptimisticLockWithGuards(ctx.container, {
        resourceKind: 'finoo_intermediaries.assignment',
        resourceId: assignment.id,
        current: assignment.updatedAt,
        expected: input.expectedUpdatedAt,
        request: ctx.request,
      })
      assignment.deletedAt = new Date()
      assignment.updatedAt = new Date()
      await em.flush()
      return assignment
    })
  },
  captureAfter: (_input, result) => assignmentSnapshot(result),
  async undo({ logEntry, ctx }) {
    const before = logEntry.snapshotBefore as AssignmentSnapshot | null
    if (!before) throw new Error('Missing assignment snapshot for undo')
    await requireStaffUndoAccess(ctx, before)
    await inCommandTransaction(ctx, async (em) => {
      const candidate = await em.findOne(FinooIntermediaryAssignment, {
        id: before.id,
        tenantId: before.tenantId,
        organizationId: before.organizationId,
      } as FilterQuery<FinooIntermediaryAssignment>)
      if (!candidate) throw notFound()
      await assertAssignmentStillEligible(em, candidate, { lock: true })
      const active = await em.findOne(FinooIntermediaryAssignment, {
        tenantId: before.tenantId,
        organizationId: before.organizationId,
        dealId: before.dealId,
        deletedAt: null,
      } as FilterQuery<FinooIntermediaryAssignment>, { lockMode: LockMode.PESSIMISTIC_WRITE })
      if (active) throw new CrudHttpError(409, { error: 'Deal already has an active assignment' })
      const assignment = await em.findOne(FinooIntermediaryAssignment, {
        id: before.id,
        tenantId: before.tenantId,
        organizationId: before.organizationId,
      } as FilterQuery<FinooIntermediaryAssignment>, { lockMode: LockMode.PESSIMISTIC_WRITE })
      if (!assignment) throw notFound()
      if (
        assignment.dealId !== candidate.dealId
        || assignment.eligibleStageId !== candidate.eligibleStageId
      ) {
        throw notFound()
      }
      const { role } = await loadAssignableIntermediary(em, {
        tenantId: before.tenantId,
        organizationId: before.organizationId,
        customerUserId: before.intermediaryCustomerUserId,
      })
      if (role.id !== before.intermediaryRoleId) throw notFound()
      assignment.deletedAt = null
      assignment.updatedAt = new Date()
      await em.flush()
    })
  },
}

export const updatePartnerStatusCommand: CommandHandler<unknown, FinooIntermediaryAssignment> = {
  id: 'finoo_intermediaries.partner_status.update',
  isUndoable: true,
  async prepare(rawInput, ctx) {
    const input = partnerStatusCommandSchema.parse(rawInput)
    const scope = requireScope(ctx)
    const assignment = await requirePortalAssignment(commandEntityManager(ctx), input.assignmentId, scope)
    return { before: assignmentSnapshot(assignment) }
  },
  async execute(rawInput, ctx) {
    const input = partnerStatusCommandSchema.parse(rawInput)
    const scope = requireScope(ctx)
    await requirePortalCommandAccess(ctx)
    return inCommandTransaction(ctx, async (em) => {
      const assignment = await requirePortalAssignment(em, input.assignmentId, scope, true)
      await enforceCommandOptimisticLockWithGuards(ctx.container, {
        resourceKind: 'finoo_intermediaries.assignment',
        resourceId: assignment.id,
        current: assignment.updatedAt,
        expected: input.expectedUpdatedAt,
        request: ctx.request,
      })
      if (!isLegalPartnerStatusTransition(assignment.partnerStatus, input.partnerStatus)) {
        throw new CrudHttpError(409, { error: 'Illegal partner status transition', code: 'illegal_transition' })
      }
      assignment.partnerStatus = input.partnerStatus
      assignment.statusUpdatedByCustomerUserId = scope.actorId
      assignment.statusUpdatedAt = new Date()
      assignment.updatedAt = new Date()
      await em.flush()
      return assignment
    })
  },
  captureAfter: (_input, result) => assignmentSnapshot(result),
  async undo({ logEntry, ctx }) {
    const before = logEntry.snapshotBefore as AssignmentSnapshot | null
    const after = logEntry.snapshotAfter as AssignmentSnapshot | null
    if (!before || !after) throw new Error('Missing partner-status snapshots for undo')
    await requireStaffUndoAccess(ctx, before)
    await inCommandTransaction(ctx, async (em) => {
      const assignment = await requirePortalSnapshotAccess(
        ctx,
        em,
        after.id,
        after,
        after.intermediaryCustomerUserId,
      )
      if (assignment.updatedAt.toISOString() !== after.updatedAt) {
        throw new CrudHttpError(409, { error: 'Assignment changed after status update' })
      }
      assignment.partnerStatus = before.partnerStatus
      assignment.statusUpdatedByCustomerUserId = before.statusUpdatedByCustomerUserId
      assignment.statusUpdatedAt = before.statusUpdatedAt ? new Date(before.statusUpdatedAt) : null
      assignment.updatedAt = new Date()
      await em.flush()
    })
  },
}

export const createNoteCommand: CommandHandler<unknown, FinooIntermediaryNote> = {
  id: 'finoo_intermediaries.note.create',
  isUndoable: true,
  async execute(rawInput, ctx) {
    const input = noteCreateCommandSchema.parse(rawInput)
    const scope = requireScope(ctx)
    await requirePortalCommandAccess(ctx)
    return inCommandTransaction(ctx, async (em) => {
      const assignment = await requirePortalAssignment(em, input.assignmentId, scope, true)
      const note = em.create(FinooIntermediaryNote, {
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        assignment,
        authorCustomerUserId: scope.actorId,
        body: input.body,
      })
      await em.persist(note).flush()
      return note
    })
  },
  captureAfter: (_input, result) => noteSnapshot(result),
  buildLog({ snapshots }) {
    const after = snapshots.after as NoteSnapshot | undefined
    return {
      resourceKind: 'finoo_intermediaries.note',
      resourceId: after?.id ?? null,
      tenantId: after?.tenantId ?? null,
      organizationId: after?.organizationId ?? null,
      snapshotAfter: noteAuditSnapshot(after),
      payload: { undo: { after } },
    }
  },
  async undo({ logEntry, ctx }) {
    const snapshot = noteUndoPayload(logEntry)?.after
    if (!snapshot) throw new Error('Missing note snapshot for undo')
    await requireStaffUndoAccess(ctx, snapshot)
    await inCommandTransaction(ctx, async (em) => {
      await requirePortalSnapshotAccess(
        ctx,
        em,
        snapshot.assignmentId,
        snapshot,
        snapshot.authorCustomerUserId,
      )
      const note = await findOneWithDecryption(
        em,
        FinooIntermediaryNote,
        noteWhere(snapshot.id, snapshot.tenantId, snapshot.organizationId),
        { lockMode: LockMode.PESSIMISTIC_WRITE },
        { tenantId: snapshot.tenantId, organizationId: snapshot.organizationId },
      )
      if (!note || note.authorCustomerUserId !== snapshot.authorCustomerUserId) throw notFound()
      if (note.updatedAt.toISOString() !== snapshot.updatedAt) {
        throw new CrudHttpError(409, { error: 'Note changed after creation' })
      }
      note.deletedAt = new Date()
      note.updatedAt = new Date()
      await em.flush()
    })
  },
}

export const updateNoteCommand: CommandHandler<unknown, FinooIntermediaryNote> = {
  id: 'finoo_intermediaries.note.update',
  isUndoable: true,
  async prepare(rawInput, ctx) {
    const input = noteUpdateCommandSchema.parse(rawInput)
    const scope = requireScope(ctx)
    const em = commandEntityManager(ctx)
    const assignment = await requirePortalAssignment(em, input.assignmentId, scope)
    const note = await requirePortalNote(em, input.noteId, assignment, scope)
    return { before: noteSnapshot(note) }
  },
  async execute(rawInput, ctx) {
    const input = noteUpdateCommandSchema.parse(rawInput)
    const scope = requireScope(ctx)
    await requirePortalCommandAccess(ctx)
    return inCommandTransaction(ctx, async (em) => {
      const assignment = await requirePortalAssignment(em, input.assignmentId, scope, true)
      const note = await requirePortalNote(em, input.noteId, assignment, scope, true)
      await enforceCommandOptimisticLockWithGuards(ctx.container, {
        resourceKind: 'finoo_intermediaries.note',
        resourceId: note.id,
        current: note.updatedAt,
        expected: input.expectedUpdatedAt,
        request: ctx.request,
      })
      note.body = input.body
      note.updatedAt = new Date()
      await em.flush()
      return note
    })
  },
  captureAfter: (_input, result) => noteSnapshot(result),
  buildLog({ snapshots }) {
    const before = snapshots.before as NoteSnapshot | undefined
    const after = snapshots.after as NoteSnapshot | undefined
    return {
      resourceKind: 'finoo_intermediaries.note',
      resourceId: after?.id ?? before?.id ?? null,
      tenantId: after?.tenantId ?? before?.tenantId ?? null,
      organizationId: after?.organizationId ?? before?.organizationId ?? null,
      snapshotBefore: noteAuditSnapshot(before),
      snapshotAfter: noteAuditSnapshot(after),
      payload: { undo: { before, after } },
    }
  },
  async undo({ logEntry, ctx }) {
    const undo = noteUndoPayload(logEntry)
    const before = undo?.before
    const after = undo?.after
    if (!before || !after) throw new Error('Missing note snapshots for undo')
    await requireStaffUndoAccess(ctx, before)
    await inCommandTransaction(ctx, async (em) => {
      const assignment = await requirePortalSnapshotAccess(
        ctx,
        em,
        before.assignmentId,
        before,
        before.authorCustomerUserId,
      )
      const scope = {
        tenantId: before.tenantId,
        organizationId: before.organizationId,
        actorId: before.authorCustomerUserId,
      }
      const note = await requirePortalNote(em, after.id, assignment, scope, true)
      if (note.updatedAt.toISOString() !== after.updatedAt) {
        throw new CrudHttpError(409, { error: 'Note changed after update' })
      }
      note.body = before.body
      note.updatedAt = new Date()
      await em.flush()
    })
  },
}

export const deleteNoteCommand: CommandHandler<unknown, FinooIntermediaryNote> = {
  id: 'finoo_intermediaries.note.delete',
  isUndoable: true,
  async prepare(rawInput, ctx) {
    const input = noteDeleteCommandSchema.parse(rawInput)
    const scope = requireScope(ctx)
    const em = commandEntityManager(ctx)
    const assignment = await requirePortalAssignment(em, input.assignmentId, scope)
    const note = await requirePortalNote(em, input.noteId, assignment, scope)
    return { before: noteSnapshot(note) }
  },
  async execute(rawInput, ctx) {
    const input = noteDeleteCommandSchema.parse(rawInput)
    const scope = requireScope(ctx)
    await requirePortalCommandAccess(ctx)
    return inCommandTransaction(ctx, async (em) => {
      const assignment = await requirePortalAssignment(em, input.assignmentId, scope, true)
      const note = await requirePortalNote(em, input.noteId, assignment, scope, true)
      await enforceCommandOptimisticLockWithGuards(ctx.container, {
        resourceKind: 'finoo_intermediaries.note',
        resourceId: note.id,
        current: note.updatedAt,
        expected: input.expectedUpdatedAt,
        request: ctx.request,
      })
      note.deletedAt = new Date()
      note.updatedAt = new Date()
      await em.flush()
      return note
    })
  },
  captureAfter: (_input, result) => noteSnapshot(result),
  buildLog({ snapshots }) {
    const before = snapshots.before as NoteSnapshot | undefined
    const after = snapshots.after as NoteSnapshot | undefined
    return {
      resourceKind: 'finoo_intermediaries.note',
      resourceId: after?.id ?? before?.id ?? null,
      tenantId: after?.tenantId ?? before?.tenantId ?? null,
      organizationId: after?.organizationId ?? before?.organizationId ?? null,
      snapshotBefore: noteAuditSnapshot(before),
      snapshotAfter: noteAuditSnapshot(after),
      payload: { undo: { before, after } },
    }
  },
  async undo({ logEntry, ctx }) {
    const before = noteUndoPayload(logEntry)?.before
    if (!before) throw new Error('Missing note snapshot for undo')
    await requireStaffUndoAccess(ctx, before)
    await inCommandTransaction(ctx, async (em) => {
      await requirePortalSnapshotAccess(
        ctx,
        em,
        before.assignmentId,
        before,
        before.authorCustomerUserId,
      )
      const note = await findOneWithDecryption(
        em,
        FinooIntermediaryNote,
        {
          id: before.id,
          tenantId: before.tenantId,
          organizationId: before.organizationId,
        } as FilterQuery<FinooIntermediaryNote>,
        { lockMode: LockMode.PESSIMISTIC_WRITE },
        { tenantId: before.tenantId, organizationId: before.organizationId },
      )
      if (!note || note.authorCustomerUserId !== before.authorCustomerUserId) throw notFound()
      note.deletedAt = null
      note.updatedAt = new Date()
      await em.flush()
    })
  },
}

registerCommand(createAssignmentCommand)
registerCommand(updateAssignmentCommand)
registerCommand(deleteAssignmentCommand)
registerCommand(updatePartnerStatusCommand)
registerCommand(createNoteCommand)
registerCommand(updateNoteCommand)
registerCommand(deleteNoteCommand)
