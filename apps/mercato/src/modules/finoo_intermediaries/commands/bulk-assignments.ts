import { randomUUID } from 'node:crypto'
import { LockMode, UniqueConstraintViolationException } from '@mikro-orm/core'
import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import { registerCommand, type CommandHandler } from '@open-mercato/shared/lib/commands'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { assertOptimisticLock } from '@open-mercato/shared/lib/crud/optimistic-lock-command'
import {
  FinooIntermediaryAssignment,
  FinooIntermediaryAssignmentBatch,
  type FinooIntermediaryAssignmentBatchResult,
} from '../data/entities'
import { bulkAssignmentCommandSchema } from '../data/validators'
import { loadScopedDeal } from '../lib/access'
import { bulkAssignmentBindingHash } from '../lib/bulkAssignments'
import { isExactEligiblePipelineName, isExactEligibleStageLabel } from '../lib/domain'

function conflict(code: string): CrudHttpError {
  return new CrudHttpError(409, { error: 'Bulk assignment selection changed', code })
}

type IdRow = { id: string }
type NamedRow = IdRow & { name: string }

async function lockAndValidateDependencies(em: EntityManager, input: {
  tenantId: string
  organizationId: string
  intermediaryCustomerUserId: string
}): Promise<{ intermediaryRoleId: string; pipelineId: string; stageId: string }> {
  const connection = em.getConnection()

  // Keep the cross-module row-lock order stable before locking sorted Deals and assignments below.
  const directoryRows = await connection.execute<Array<IdRow & { lifecycle_state: string; deleted_at: Date | null }>>(
    `select id, lifecycle_state, deleted_at
       from finoo_intermediaries
      where tenant_id = ? and organization_id = ? and customer_user_id = ?
      order by id
      for update`,
    [input.tenantId, input.organizationId, input.intermediaryCustomerUserId],
  )
  if (directoryRows.length !== 1 || directoryRows[0].lifecycle_state !== 'active' || directoryRows[0].deleted_at) {
    throw new CrudHttpError(404, { error: 'Resource not found' })
  }

  const userRows = await connection.execute<Array<IdRow & { is_active: boolean; deleted_at: Date | null }>>(
    `select id, is_active, deleted_at
       from customer_users
      where id = ? and tenant_id = ? and organization_id = ?
      for update`,
    [input.intermediaryCustomerUserId, input.tenantId, input.organizationId],
  )
  if (userRows.length !== 1 || !userRows[0].is_active || userRows[0].deleted_at) {
    throw new CrudHttpError(404, { error: 'Resource not found' })
  }

  const roleRows = await connection.execute<Array<IdRow & { deleted_at: Date | null }>>(
    `select id, deleted_at
       from customer_roles
      where tenant_id = ? and organization_id = ? and slug = 'intermediary'
      order by id
      for update`,
    [input.tenantId, input.organizationId],
  )
  const activeRoles = roleRows.filter((row) => !row.deleted_at)
  if (activeRoles.length !== 1) {
    throw new CrudHttpError(422, {
      error: 'Intermediary role configuration is ambiguous or missing',
      code: 'intermediary_role_configuration',
    })
  }
  const intermediaryRoleId = activeRoles[0].id

  const membershipRows = await connection.execute<Array<IdRow & { deleted_at: Date | null }>>(
    `select id, deleted_at
       from customer_user_roles
      where user_id = ? and role_id = ?
      order by id
      for update`,
    [input.intermediaryCustomerUserId, intermediaryRoleId],
  )
  if (membershipRows.length !== 1 || membershipRows[0].deleted_at) {
    throw new CrudHttpError(404, { error: 'Resource not found' })
  }

  const pipelineRows = await connection.execute<NamedRow[]>(
    `select id, name
       from customer_pipelines
      where tenant_id = ? and organization_id = ?
      order by id
      for update`,
    [input.tenantId, input.organizationId],
  )
  const eligiblePipelines = pipelineRows.filter((row) => isExactEligiblePipelineName(row.name))
  if (eligiblePipelines.length !== 1) {
    throw new CrudHttpError(422, {
      error: 'Intermediary pipeline configuration is ambiguous or missing',
      code: 'eligible_pipeline_configuration',
    })
  }
  const pipelineId = eligiblePipelines[0].id

  const stageRows = await connection.execute<NamedRow[]>(
    `select id, name
       from customer_pipeline_stages
      where tenant_id = ? and organization_id = ? and pipeline_id = ?
      order by id
      for update`,
    [input.tenantId, input.organizationId, pipelineId],
  )
  const eligibleStages = stageRows.filter((row) => isExactEligibleStageLabel(row.name))
  if (eligibleStages.length !== 1) {
    throw new CrudHttpError(422, {
      error: 'Intermediary stage configuration is ambiguous or missing',
      code: 'eligible_stage_configuration',
    })
  }

  return { intermediaryRoleId, pipelineId, stageId: eligibleStages[0].id }
}

export const bulkAssignIntermediaryCommand: CommandHandler<unknown, FinooIntermediaryAssignmentBatchResult> = {
  id: 'finoo_intermediaries.assignment.bulk_upsert',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const input = bulkAssignmentCommandSchema.parse(rawInput)
    if (!ctx.systemActor) throw new CrudHttpError(403, { error: 'Forbidden' })
    if (ctx.selectedOrganizationId !== input.organizationId) {
      throw new CrudHttpError(404, { error: 'Resource not found' })
    }
    const rootEm = ctx.transactionalEm ?? (ctx.container.resolve('em') as EntityManager)
    const run = async (em: EntityManager): Promise<FinooIntermediaryAssignmentBatchResult> => {
      await em.getConnection().execute('select pg_advisory_xact_lock(hashtext(?))', [input.operationId])
      const bindingHash = bulkAssignmentBindingHash(input)
      const existingReceipt = await em.findOne(FinooIntermediaryAssignmentBatch, {
        id: input.operationId,
        tenantId: input.tenantId,
        organizationId: input.organizationId,
      } as FilterQuery<FinooIntermediaryAssignmentBatch>)
      if (existingReceipt) {
        if (existingReceipt.bindingHash !== bindingHash) throw conflict('operation_binding_mismatch')
        return existingReceipt.result
      }

      const dependencies = await lockAndValidateDependencies(em, {
        tenantId: input.tenantId,
        organizationId: input.organizationId,
        intermediaryCustomerUserId: input.intermediaryCustomerUserId,
      })
      const result: FinooIntermediaryAssignmentBatchResult = {
        assignmentIds: [],
        createdCount: 0,
        reassignedCount: 0,
        unchangedCount: 0,
      }

      for (const expected of [...input.deals].sort((left, right) => left.id.localeCompare(right.id))) {
        const deal = await loadScopedDeal(em, {
          tenantId: input.tenantId,
          organizationId: input.organizationId,
          dealId: expected.id,
        }, true)
        if (deal.pipelineId !== dependencies.pipelineId || deal.pipelineStageId !== dependencies.stageId) {
          throw new CrudHttpError(422, { error: 'Deal is not in the eligible stage', code: 'ineligible_stage' })
        }
        assertOptimisticLock({
          resourceKind: 'customers.deal',
          resourceId: deal.id,
          expected: expected.updatedAt,
          current: deal.updatedAt,
        })

        const assignment = await em.findOne(FinooIntermediaryAssignment, {
          tenantId: input.tenantId,
          organizationId: input.organizationId,
          dealId: deal.id,
          deletedAt: null,
        } as FilterQuery<FinooIntermediaryAssignment>, { lockMode: LockMode.PESSIMISTIC_WRITE })
        if (!assignment && expected.assignmentId) throw conflict('assignment_removed')
        if (assignment && assignment.id !== expected.assignmentId) throw conflict('assignment_changed')
        if (assignment) {
          assertOptimisticLock({
            resourceKind: 'finoo_intermediaries.assignment',
            resourceId: assignment.id,
            expected: expected.assignmentUpdatedAt,
            current: assignment.updatedAt,
          })
          result.assignmentIds.push(assignment.id)
          if (assignment.intermediaryCustomerUserId === input.intermediaryCustomerUserId) {
            result.unchangedCount += 1
            continue
          }
          if (!input.confirmReassign) throw conflict('reassignment_confirmation_required')
          assignment.intermediaryCustomerUserId = input.intermediaryCustomerUserId
          assignment.intermediaryRoleId = dependencies.intermediaryRoleId
          assignment.assignedByUserId = input.actorUserId
          assignment.updatedAt = new Date()
          result.reassignedCount += 1
          continue
        }

        const created = em.create(FinooIntermediaryAssignment, {
          id: randomUUID(),
          tenantId: input.tenantId,
          organizationId: input.organizationId,
          dealId: deal.id,
          intermediaryCustomerUserId: input.intermediaryCustomerUserId,
          intermediaryRoleId: dependencies.intermediaryRoleId,
          eligibleStageId: dependencies.stageId,
          partnerStatus: 'new',
          assignedByUserId: input.actorUserId,
        })
        em.persist(created)
        result.assignmentIds.push(created.id)
        result.createdCount += 1
      }

      em.persist(em.create(FinooIntermediaryAssignmentBatch, {
        id: input.operationId,
        tenantId: input.tenantId,
        organizationId: input.organizationId,
        bindingHash,
        result,
        completedAt: new Date(),
      }))
      await em.flush()
      return result
    }

    try {
      return await (ctx.transactionalEm ? run(ctx.transactionalEm) : rootEm.transactional(run))
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException) throw conflict('assignment_changed')
      throw error
    }
  },
  captureAfter: (_input, result) => ({
    assignmentIds: result.assignmentIds,
    createdCount: result.createdCount,
    reassignedCount: result.reassignedCount,
    unchangedCount: result.unchangedCount,
  }),
}

registerCommand(bulkAssignIntermediaryCommand)
