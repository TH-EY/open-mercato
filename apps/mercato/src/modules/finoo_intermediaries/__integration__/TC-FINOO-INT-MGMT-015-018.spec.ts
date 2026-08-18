import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { drainIntegrationQueue } from '@open-mercato/core/helpers/integration/queue'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import {
  cleanupScenario,
  createCustomerUser,
  createScenario,
  inviteIntermediary,
  queryDatabase,
  runLifecycleAction,
  scopedApiRequest,
  type Scenario,
} from './helpers'

type PreflightDeal = {
  id: string
  state: 'available' | 'blocked'
  updatedAt: string | null
  blockedReason: 'ineligible_stage' | 'not_found' | null
  assignment: { id: string; updatedAt: string; intermediaryCustomerUserId: string } | null
}

async function seedEligibleDeals(scenario: Scenario, count: number) {
  const pipelineId = randomUUID()
  const stageId = randomUUID()
  await queryDatabase(
    `insert into customer_pipelines (id,organization_id,tenant_id,name,is_default,created_at,updated_at)
     values ($1,$2,$3,'Web Form Sales Pipeline',false,now(),now())`,
    [pipelineId, scenario.organizationId, scenario.tenantId],
  )
  await queryDatabase(
    `insert into customer_pipeline_stages (id,organization_id,tenant_id,pipeline_id,name,position,created_at,updated_at)
     values ($1,$2,$3,$4,'Sent To Partners',1,now(),now())`,
    [stageId, scenario.organizationId, scenario.tenantId, pipelineId],
  )
  const dealIds = Array.from({ length: count }, () => randomUUID()).sort()
  for (const [index, dealId] of dealIds.entries()) {
    await queryDatabase(
      `insert into customer_deals
        (id,organization_id,tenant_id,title,status,pipeline_id,pipeline_stage_id,created_at,updated_at)
       values ($1,$2,$3,$4,'open',$5,$6,now(),now())`,
      [dealId, scenario.organizationId, scenario.tenantId, `Bulk mixed Deal ${index + 1}`, pipelineId, stageId],
    )
  }
  return { dealIds, pipelineId, stageId }
}

async function loadPreflight(request: Parameters<typeof scopedApiRequest>[0], scenario: Scenario, dealIds: string[]) {
  const response = await scopedApiRequest(
    request,
    scenario,
    'GET',
    `/api/finoo_intermediaries/admin/bulk-assignments?dealIds=${dealIds.join(',')}`,
  )
  expect(response.status()).toBe(200)
  return (await readJsonSafe<{ deals: PreflightDeal[] }>(response))!.deals
}

function requestDeals(deals: PreflightDeal[]) {
  return deals.flatMap((deal) => deal.state === 'available' && deal.updatedAt
    ? [{
        id: deal.id,
        updatedAt: deal.updatedAt,
        assignmentId: deal.assignment?.id ?? null,
        assignmentUpdatedAt: deal.assignment?.updatedAt ?? null,
      }]
    : [])
}

test('TC-FINOO-INT-MGMT-015 enforces confirmation and commits a mixed create, no-op, and reassignment batch', async ({ request }) => {
  let scenario: Scenario | null = null
  try {
    scenario = await createScenario(request, 'TC-FINOO-INT-MGMT-015')
    const target = await createCustomerUser(request, scenario, { email: `target-${scenario.recipient}` })
    const previous = await createCustomerUser(request, scenario, { email: `previous-${scenario.recipient}` })
    expect((await inviteIntermediary(request, scenario, { email: target.email })).body.item.status).toBe('active')
    expect((await inviteIntermediary(request, scenario, { email: previous.email })).body.item.status).toBe('active')
    const { dealIds, stageId } = await seedEligibleDeals(scenario, 3)
    const unchangedAssignmentId = randomUUID()
    const reassignedAssignmentId = randomUUID()
    await queryDatabase(
      `insert into finoo_intermediary_assignments
        (id,tenant_id,organization_id,deal_id,intermediary_customer_user_id,intermediary_role_id,eligible_stage_id,partner_status,assigned_by_user_id,created_at,updated_at)
       values
        ($1,$2,$3,$4,$5,$6,$7,'new',$8,now(),now()),
        ($9,$2,$3,$10,$11,$6,$7,'in_progress',$8,now(),now())`,
      [
        unchangedAssignmentId, scenario.tenantId, scenario.organizationId, dealIds[1], target.id,
        scenario.intermediaryRoleId, stageId, scenario.staffUserId,
        reassignedAssignmentId, dealIds[2], previous.id,
      ],
    )
    const deals = await loadPreflight(request, scenario, dealIds)
    const body = {
      intermediaryCustomerUserId: target.id,
      confirmReassign: false,
      deals: requestDeals(deals),
    }
    const denied = await scopedApiRequest(request, scenario, 'POST', '/api/finoo_intermediaries/admin/bulk-assignments', body)
    expect(denied.status()).toBe(409)
    expect(await readJsonSafe(denied)).toMatchObject({ code: 'reassignment_confirmation_required', reassignCount: 1 })

    await queryDatabase(
      'update finoo_intermediary_assignments set updated_at=now() + interval \'1 second\' where id=$1',
      [unchangedAssignmentId],
    )
    const staleAssignment = await scopedApiRequest(
      request,
      scenario,
      'POST',
      '/api/finoo_intermediaries/admin/bulk-assignments',
      { ...body, confirmReassign: true },
    )
    expect(staleAssignment.status()).toBe(409)
    expect(await readJsonSafe(staleAssignment)).toMatchObject({ code: 'optimistic_lock_conflict' })
    const refreshedDeals = await loadPreflight(request, scenario, dealIds)

    const accepted = await scopedApiRequest(
      request,
      scenario,
      'POST',
      '/api/finoo_intermediaries/admin/bulk-assignments',
      { ...body, confirmReassign: true, deals: requestDeals(refreshedDeals) },
    )
    expect(accepted.status()).toBe(202)
    expect(await readJsonSafe(accepted)).toMatchObject({ createCount: 1, reassignCount: 1, unchangedCount: 1 })
    await drainIntegrationQueue('finoo-intermediaries-assignment-bulk')

    const assignments = await queryDatabase<{
      id: string
      deal_id: string
      intermediary_customer_user_id: string
      partner_status: string
    }>(
      `select id, deal_id, intermediary_customer_user_id, partner_status
         from finoo_intermediary_assignments
        where tenant_id=$1 and organization_id=$2 and deleted_at is null
        order by deal_id`,
      [scenario.tenantId, scenario.organizationId],
    )
    expect(assignments).toHaveLength(3)
    expect(assignments.every((assignment) => assignment.intermediary_customer_user_id === target.id)).toBe(true)
    expect(assignments.find((assignment) => assignment.id === unchangedAssignmentId)?.partner_status).toBe('new')
    expect(assignments.find((assignment) => assignment.id === reassignedAssignmentId)?.partner_status).toBe('in_progress')
  } finally {
    await cleanupScenario(request, scenario)
  }
})

test('TC-FINOO-INT-MGMT-016-018 rejects stale and inactive state and rolls back a late atomic failure', async ({ request }) => {
  let scenario: Scenario | null = null
  let foreignScenario: Scenario | null = null
  try {
    scenario = await createScenario(request, 'TC-FINOO-INT-MGMT-016-018')
    foreignScenario = await createScenario(request, 'TC-FINOO-INT-MGMT-018-FOREIGN')
    const target = await createCustomerUser(request, scenario, { email: `atomic-${scenario.recipient}` })
    const directory = await inviteIntermediary(request, scenario, { email: target.email })
    expect(directory.body.item.status).toBe('active')
    const { dealIds, pipelineId } = await seedEligibleDeals(scenario, 2)
    const original = await loadPreflight(request, scenario, dealIds)

    await queryDatabase('update customer_deals set updated_at=now() + interval \'1 second\' where id=$1', [dealIds[0]])
    const stale = await scopedApiRequest(request, scenario, 'POST', '/api/finoo_intermediaries/admin/bulk-assignments', {
      intermediaryCustomerUserId: target.id,
      confirmReassign: false,
      deals: requestDeals(original),
    })
    expect(stale.status()).toBe(409)

    const fresh = await loadPreflight(request, scenario, dealIds)
    const lateFailure = await scopedApiRequest(request, scenario, 'POST', '/api/finoo_intermediaries/admin/bulk-assignments', {
      intermediaryCustomerUserId: target.id,
      confirmReassign: false,
      deals: requestDeals(fresh),
    })
    expect(lateFailure.status()).toBe(202)
    const lateFailureBody = (await readJsonSafe<{ progressJobId: string }>(lateFailure))!
    const otherStageId = randomUUID()
    await queryDatabase(
      `insert into customer_pipeline_stages (id,organization_id,tenant_id,pipeline_id,name,position,created_at,updated_at)
       values ($1,$2,$3,$4,'Other',2,now(),now())`,
      [otherStageId, scenario.organizationId, scenario.tenantId, pipelineId],
    )
    await queryDatabase(
      'update customer_deals set pipeline_stage_id=$1, updated_at=now() + interval \'2 seconds\' where id=$2',
      [otherStageId, dealIds[1]],
    )
    expect(await drainIntegrationQueue('finoo-intermediaries-assignment-bulk')).toBe(1)
    const rolledBack = await queryDatabase<{ count: string }>(
      'select count(*)::text as count from finoo_intermediary_assignments where tenant_id=$1 and organization_id=$2',
      [scenario.tenantId, scenario.organizationId],
    )
    expect(rolledBack[0]?.count).toBe('0')
    const retryingJob = await queryDatabase<{ status: string }>(
      'select status from progress_jobs where id=$1 and tenant_id=$2 and organization_id=$3',
      [lateFailureBody.progressJobId, scenario.tenantId, scenario.organizationId],
    )
    expect(retryingJob).toEqual([{ status: 'running' }])

    const inactive = await runLifecycleAction(request, scenario, directory.body.item, 'deactivate')
    expect(inactive.body.item.status).toBe('inactive')
    const inactiveTarget = await scopedApiRequest(request, scenario, 'POST', '/api/finoo_intermediaries/admin/bulk-assignments', {
      intermediaryCustomerUserId: target.id,
      confirmReassign: false,
      deals: requestDeals([fresh[0]]),
    })
    expect(inactiveTarget.status()).toBe(404)

    const foreignDeals = await seedEligibleDeals(foreignScenario, 1)
    const hidden = await loadPreflight(request, scenario, foreignDeals.dealIds)
    expect(hidden).toEqual([expect.objectContaining({ state: 'blocked', blockedReason: 'not_found' })])
  } finally {
    await cleanupScenario(request, foreignScenario)
    await cleanupScenario(request, scenario)
  }
})
