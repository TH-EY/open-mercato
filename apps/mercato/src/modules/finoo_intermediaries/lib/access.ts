import { LockMode } from '@mikro-orm/core'
import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import {
  CustomerRole,
  CustomerUser,
  CustomerUserRole,
} from '@open-mercato/core/modules/customer_accounts/data/entities'
import {
  CustomerDeal,
  CustomerPipeline,
  CustomerPipelineStage,
} from '@open-mercato/core/modules/customers/data/entities'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import type { FinooIntermediaryAssignment } from '../data/entities'
import {
  isExactEligiblePipelineName,
  isExactEligibleStageLabel,
  scopedActiveAssignmentWhere,
} from './domain'

export type ScopedDealInput = {
  tenantId: string
  organizationId: string
  dealId: string
}

export type ScopedCustomerUserInput = {
  tenantId: string
  organizationId: string
  customerUserId: string
}

export type AssignmentEligibility = {
  canManage: boolean
  reason: 'ineligible_stage' | null
}

function inaccessible(): CrudHttpError {
  return new CrudHttpError(404, { error: 'Resource not found' })
}

function ineligibleStage(): CrudHttpError {
  return new CrudHttpError(422, { error: 'Deal is not in the eligible stage', code: 'ineligible_stage' })
}

async function loadScopedDeal(
  em: EntityManager,
  input: ScopedDealInput,
  lock = false,
) {
  const deal = await em.findOne(CustomerDeal, {
    id: input.dealId,
    tenantId: input.tenantId,
    organizationId: input.organizationId,
    deletedAt: null,
  } as FilterQuery<CustomerDeal>, lock ? { lockMode: LockMode.PESSIMISTIC_WRITE } : undefined)
  if (!deal) throw inaccessible()
  return deal
}

async function loadEligibleConfiguration(em: EntityManager, input: ScopedDealInput) {
  const pipelines = await em.find(CustomerPipeline, {
    tenantId: input.tenantId,
    organizationId: input.organizationId,
  } as FilterQuery<CustomerPipeline>)
  const eligiblePipelines = pipelines.filter((pipeline) => isExactEligiblePipelineName(pipeline.name))
  if (eligiblePipelines.length !== 1) {
    throw new CrudHttpError(422, {
      error: 'Intermediary pipeline configuration is ambiguous or missing',
      code: 'eligible_pipeline_configuration',
    })
  }

  const stages = await em.find(CustomerPipelineStage, {
    tenantId: input.tenantId,
    organizationId: input.organizationId,
    pipelineId: eligiblePipelines[0].id,
  } as FilterQuery<CustomerPipelineStage>)
  const eligibleStages = stages.filter((stage) => isExactEligibleStageLabel(stage.label))
  if (eligibleStages.length !== 1) {
    throw new CrudHttpError(422, {
      error: 'Intermediary stage configuration is ambiguous or missing',
      code: 'eligible_stage_configuration',
    })
  }
  const stage = eligibleStages[0]
  return { stage, pipeline: eligiblePipelines[0] }
}

export async function resolveAssignmentEligibility(
  em: EntityManager,
  input: ScopedDealInput & { eligibleStageId?: string },
): Promise<AssignmentEligibility> {
  if (input.eligibleStageId) {
    const deal = await loadScopedDeal(em, input)
    const canManage = deal.pipelineStageId === input.eligibleStageId
    return { canManage, reason: canManage ? null : 'ineligible_stage' }
  }

  const deal = await loadScopedDeal(em, input)
  if (!deal.pipelineStageId) return { canManage: false, reason: 'ineligible_stage' }
  const { stage, pipeline } = await loadEligibleConfiguration(em, input)
  const canManage = deal.pipelineId === pipeline.id && deal.pipelineStageId === stage.id
  return { canManage, reason: canManage ? null : 'ineligible_stage' }
}

export async function loadEligibleDeal(em: EntityManager, input: ScopedDealInput, lock = false) {
  const deal = await loadScopedDeal(em, input, lock)
  if (!deal.pipelineStageId) throw ineligibleStage()
  const { stage, pipeline } = await loadEligibleConfiguration(em, input)
  if (deal.pipelineId !== pipeline.id || deal.pipelineStageId !== stage.id) {
    throw ineligibleStage()
  }
  return { deal, stage }
}

export async function assertAssignmentStillEligible(
  em: EntityManager,
  assignment: FinooIntermediaryAssignment,
  options: { lock?: boolean; maskIneligible?: boolean } = {},
): Promise<void> {
  const deal = await loadScopedDeal(em, {
    tenantId: assignment.tenantId,
    organizationId: assignment.organizationId,
    dealId: assignment.dealId,
  }, options.lock)
  if (deal.pipelineStageId !== assignment.eligibleStageId) {
    if (options.maskIneligible) throw inaccessible()
    throw ineligibleStage()
  }
}

export async function loadAssignableIntermediary(
  em: EntityManager,
  input: ScopedCustomerUserInput,
) {
  const roles = await em.find(CustomerRole, {
    tenantId: input.tenantId,
    organizationId: input.organizationId,
    slug: 'intermediary',
    deletedAt: null,
  } as FilterQuery<CustomerRole>)
  if (roles.length !== 1) {
    throw new CrudHttpError(422, {
      error: 'Intermediary role configuration is ambiguous or missing',
      code: 'intermediary_role_configuration',
    })
  }
  const role = roles[0]

  const user = await em.findOne(CustomerUser, {
    id: input.customerUserId,
    tenantId: input.tenantId,
    organizationId: input.organizationId,
    isActive: true,
    deletedAt: null,
  } as FilterQuery<CustomerUser>)
  if (!user) throw inaccessible()

  const membership = await em.findOne(CustomerUserRole, {
    user: user.id,
    role: role.id,
    deletedAt: null,
  } as FilterQuery<CustomerUserRole>)
  if (!membership) throw inaccessible()
  return { role, user }
}

export async function assertPortalAssignmentAccess(
  em: EntityManager,
  assignment: FinooIntermediaryAssignment,
  input: ScopedCustomerUserInput,
): Promise<void> {
  if (
    assignment.tenantId !== input.tenantId
    || assignment.organizationId !== input.organizationId
    || assignment.intermediaryCustomerUserId !== input.customerUserId
    || assignment.deletedAt
  ) {
    throw inaccessible()
  }

  const role = await em.findOne(CustomerRole, {
    id: assignment.intermediaryRoleId,
    tenantId: input.tenantId,
    organizationId: input.organizationId,
    deletedAt: null,
  } as FilterQuery<CustomerRole>)
  const user = await em.findOne(CustomerUser, {
    id: input.customerUserId,
    tenantId: input.tenantId,
    organizationId: input.organizationId,
    isActive: true,
    deletedAt: null,
  } as FilterQuery<CustomerUser>)
  if (!role || !user) throw inaccessible()

  const membership = await em.findOne(CustomerUserRole, {
    user: user.id,
    role: role.id,
    deletedAt: null,
  } as FilterQuery<CustomerUserRole>)
  if (!membership) throw inaccessible()

  const deal = await em.findOne(CustomerDeal, {
    id: assignment.dealId,
    tenantId: input.tenantId,
    organizationId: input.organizationId,
    pipelineStageId: assignment.eligibleStageId,
    deletedAt: null,
  } as FilterQuery<CustomerDeal>)
  if (!deal) throw inaccessible()
}

export function portalAssignmentWhere(input: ScopedCustomerUserInput) {
  return scopedActiveAssignmentWhere({
    tenantId: input.tenantId,
    organizationId: input.organizationId,
    intermediaryCustomerUserId: input.customerUserId,
  })
}

export async function filterAuthorizedPortalAssignments(
  em: EntityManager,
  assignments: FinooIntermediaryAssignment[],
  input: ScopedCustomerUserInput,
): Promise<FinooIntermediaryAssignment[]> {
  if (assignments.length === 0) return []
  const user = await em.findOne(CustomerUser, {
    id: input.customerUserId,
    tenantId: input.tenantId,
    organizationId: input.organizationId,
    isActive: true,
    deletedAt: null,
  } as FilterQuery<CustomerUser>)
  if (!user) return []

  const roleIds = [...new Set(assignments.map((assignment) => assignment.intermediaryRoleId))]
  const roles = await em.find(CustomerRole, {
    id: { $in: roleIds },
    tenantId: input.tenantId,
    organizationId: input.organizationId,
    deletedAt: null,
  } as FilterQuery<CustomerRole>)
  const validRoleIds = new Set(roles.map((role) => role.id))
  const memberships = validRoleIds.size
    ? await em.find(CustomerUserRole, {
        user: user.id,
        role: { $in: [...validRoleIds] },
        deletedAt: null,
      } as FilterQuery<CustomerUserRole>, { populate: ['role'] })
    : []
  const memberRoleIds = new Set(memberships.map((membership) => membership.role.id))

  const dealIds = assignments.map((assignment) => assignment.dealId)
  const deals = await em.find(CustomerDeal, {
    id: { $in: dealIds },
    tenantId: input.tenantId,
    organizationId: input.organizationId,
    deletedAt: null,
  } as FilterQuery<CustomerDeal>)
  const stageByDealId = new Map(deals.map((deal) => [deal.id, deal.pipelineStageId]))
  return assignments.filter((assignment) => (
    assignment.tenantId === input.tenantId
    && assignment.organizationId === input.organizationId
    && assignment.intermediaryCustomerUserId === input.customerUserId
    && !assignment.deletedAt
    && memberRoleIds.has(assignment.intermediaryRoleId)
    && stageByDealId.get(assignment.dealId) === assignment.eligibleStageId
  ))
}
