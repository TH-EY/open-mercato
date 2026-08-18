import { createHash } from 'node:crypto'
import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import { CustomerUser } from '@open-mercato/core/modules/customer_accounts/data/entities'
import { CustomerDeal } from '@open-mercato/core/modules/customers/data/entities'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { FinooIntermediaryAssignment } from '../data/entities'
import type { BulkAssignmentCommandInput } from '../data/validators'
import { loadEligibleConfiguration, loadEligibleIntermediaryUsers } from './access'

export type BulkAssignmentPreflightDeal =
  | {
      id: string
      state: 'blocked'
      name: null
      updatedAt: null
      blockedReason: 'not_found'
      assignment: null
    }
  | {
      id: string
      state: 'available'
      name: string
      updatedAt: string
      blockedReason: 'ineligible_stage' | null
      assignment: {
        id: string
        intermediaryCustomerUserId: string
        intermediaryDisplayName: string | null
        updatedAt: string
      } | null
    }

export type BulkAssignmentPreflight = {
  deals: BulkAssignmentPreflightDeal[]
  intermediaries: Array<{ id: string; displayName: string; email: string }>
}

export function canonicalBulkAssignmentDealIds(ids: string[]): string[] {
  return [...new Set(ids)].sort()
}

export function bulkAssignmentBindingHash(
  input: Pick<BulkAssignmentCommandInput, 'tenantId' | 'organizationId' | 'intermediaryCustomerUserId' | 'confirmReassign' | 'deals'>,
): string {
  const canonical = {
    tenantId: input.tenantId,
    organizationId: input.organizationId,
    intermediaryCustomerUserId: input.intermediaryCustomerUserId,
    confirmReassign: input.confirmReassign,
    deals: [...input.deals].sort((left, right) => left.id.localeCompare(right.id)),
  }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

export async function loadBulkAssignmentPreflight(
  em: EntityManager,
  input: { tenantId: string; organizationId: string; dealIds: string[] },
): Promise<BulkAssignmentPreflight> {
  const dealIds = canonicalBulkAssignmentDealIds(input.dealIds)
  const configuration = await loadEligibleConfiguration(em, {
    tenantId: input.tenantId,
    organizationId: input.organizationId,
    dealId: dealIds[0],
  })
  const deals = await findWithDecryption(
    em,
    CustomerDeal,
    {
      id: { $in: dealIds },
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      deletedAt: null,
    } as FilterQuery<CustomerDeal>,
    undefined,
    { tenantId: input.tenantId, organizationId: input.organizationId },
  )
  const dealById = new Map(deals.map((deal) => [deal.id, deal]))
  const assignments = dealIds.length === 0
    ? []
    : await em.find(FinooIntermediaryAssignment, {
        tenantId: input.tenantId,
        organizationId: input.organizationId,
        dealId: { $in: dealIds },
        deletedAt: null,
      } as FilterQuery<FinooIntermediaryAssignment>)
  const assignmentByDealId = new Map(assignments.map((assignment) => [assignment.dealId, assignment]))
  const currentUserIds = [...new Set(assignments.map((assignment) => assignment.intermediaryCustomerUserId))]
  const currentUsers = currentUserIds.length === 0
    ? []
    : await findWithDecryption(
        em,
        CustomerUser,
        {
          id: { $in: currentUserIds },
          tenantId: input.tenantId,
          organizationId: input.organizationId,
          deletedAt: null,
        } as FilterQuery<CustomerUser>,
        undefined,
        { tenantId: input.tenantId, organizationId: input.organizationId },
      )
  const currentUserById = new Map(currentUsers.map((user) => [user.id, user]))
  const eligible = await loadEligibleIntermediaryUsers(em, input)

  return {
    deals: dealIds.map((id): BulkAssignmentPreflightDeal => {
      const deal = dealById.get(id)
      if (!deal) {
        return { id, state: 'blocked', name: null, updatedAt: null, blockedReason: 'not_found', assignment: null }
      }
      const assignment = assignmentByDealId.get(id)
      return {
        id,
        state: 'available',
        name: deal.title,
        updatedAt: deal.updatedAt.toISOString(),
        blockedReason: deal.pipelineId === configuration.pipeline.id && deal.pipelineStageId === configuration.stage.id
          ? null
          : 'ineligible_stage',
        assignment: assignment
          ? {
              id: assignment.id,
              intermediaryCustomerUserId: assignment.intermediaryCustomerUserId,
              intermediaryDisplayName: currentUserById.get(assignment.intermediaryCustomerUserId)?.displayName ?? null,
              updatedAt: assignment.updatedAt.toISOString(),
            }
          : null,
      }
    }),
    intermediaries: eligible.users.map((user) => ({
      id: user.id,
      displayName: user.displayName,
      email: user.email,
    })),
  }
}
