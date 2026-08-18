import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { drainIntegrationQueue } from '@open-mercato/core/helpers/integration/queue'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { getFinooIntermediaryBulkAssignmentQueue } from '../lib/bulkAssignmentQueue'
import {
  cleanupScenario,
  createCustomerUser,
  createScenario,
  inviteIntermediary,
  queryDatabase,
  scopedApiRequest,
  type Scenario,
} from './helpers'

type Preflight = {
  deals: Array<{
    id: string
    state: 'available' | 'blocked'
    updatedAt: string | null
    blockedReason: 'ineligible_stage' | 'not_found' | null
    assignment: { id: string; updatedAt: string; intermediaryCustomerUserId: string } | null
  }>
  intermediaries: Array<{ id: string }>
}

test('TC-FINOO-INT-MGMT-014 atomically assigns selected Deals and treats an exact replay as a no-op', async ({ request }) => {
  let scenario: Scenario | null = null
  try {
    scenario = await createScenario(request, 'TC-FINOO-INT-MGMT-014')
    const target = await createCustomerUser(request, scenario, { email: `bulk-${scenario.recipient}` })
    const directory = await inviteIntermediary(request, scenario, { email: target.email })
    expect(directory.body.item.status).toBe('active')

    const pipelineId = randomUUID()
    const stageId = randomUUID()
    const dealIds = [randomUUID(), randomUUID()]
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
    for (const [index, dealId] of dealIds.entries()) {
      await queryDatabase(
        `insert into customer_deals
          (id,organization_id,tenant_id,title,status,pipeline_id,pipeline_stage_id,created_at,updated_at)
         values ($1,$2,$3,$4,'open',$5,$6,now(),now())`,
        [dealId, scenario.organizationId, scenario.tenantId, `Bulk Deal ${index + 1}`, pipelineId, stageId],
      )
    }

    const selection = [...dealIds].reverse().join(',')
    const preflightResponse = await scopedApiRequest(
      request,
      scenario,
      'GET',
      `/api/finoo_intermediaries/admin/bulk-assignments?dealIds=${selection}`,
    )
    expect(preflightResponse.status()).toBe(200)
    const preflight = (await readJsonSafe<Preflight>(preflightResponse))!
    expect(preflight.deals.map((deal) => deal.id)).toEqual([...dealIds].sort())
    expect(preflight.deals.every((deal) => deal.state === 'available' && deal.blockedReason === null)).toBe(true)
    expect(preflight.intermediaries.some((intermediary) => intermediary.id === target.id)).toBe(true)

    const requestBody = {
      intermediaryCustomerUserId: target.id,
      confirmReassign: false,
      deals: preflight.deals.map((deal) => ({
        id: deal.id,
        updatedAt: deal.updatedAt!,
        assignmentId: null,
        assignmentUpdatedAt: null,
      })),
    }
    const queuedResponse = await scopedApiRequest(
      request,
      scenario,
      'POST',
      '/api/finoo_intermediaries/admin/bulk-assignments',
      requestBody,
    )
    expect(queuedResponse.status()).toBe(202)
    const queuedBody = (await readJsonSafe<{ progressJobId: string }>(queuedResponse))!
    expect(queuedBody).toMatchObject({ createCount: 2, reassignCount: 0, unchangedCount: 0 })
    await drainIntegrationQueue('finoo-intermediaries-assignment-bulk')

    const assignments = await queryDatabase<{ deal_id: string; intermediary_customer_user_id: string }>(
      `select deal_id, intermediary_customer_user_id
       from finoo_intermediary_assignments
       where tenant_id=$1 and organization_id=$2 and deleted_at is null
       order by deal_id`,
      [scenario.tenantId, scenario.organizationId],
    )
    expect(assignments).toEqual([...dealIds].sort().map((dealId) => ({
      deal_id: dealId,
      intermediary_customer_user_id: target.id,
    })))
    const receipts = await queryDatabase<{ count: string }>(
      'select count(*)::text as count from finoo_intermediary_assignment_batches where tenant_id=$1 and organization_id=$2',
      [scenario.tenantId, scenario.organizationId],
    )
    expect(receipts[0]?.count).toBe('1')

    const assignmentVersionsBeforeReplay = await queryDatabase<{ id: string; updated_at: Date }>(
      `select id, updated_at
         from finoo_intermediary_assignments
        where tenant_id=$1 and organization_id=$2 and deleted_at is null
        order by id`,
      [scenario.tenantId, scenario.organizationId],
    )
    await getFinooIntermediaryBulkAssignmentQueue().enqueue({
      progressJobId: queuedBody.progressJobId,
      tenantId: scenario.tenantId,
      organizationId: scenario.organizationId,
      userId: scenario.staffUserId,
      failureMessage: 'Bulk intermediary assignment failed.',
      intermediaryCustomerUserId: target.id,
      confirmReassign: false,
      deals: requestBody.deals,
    })
    expect(await drainIntegrationQueue('finoo-intermediaries-assignment-bulk')).toBe(1)
    const assignmentVersionsAfterReplay = await queryDatabase<{ id: string; updated_at: Date }>(
      `select id, updated_at
         from finoo_intermediary_assignments
        where tenant_id=$1 and organization_id=$2 and deleted_at is null
        order by id`,
      [scenario.tenantId, scenario.organizationId],
    )
    expect(assignmentVersionsAfterReplay).toEqual(assignmentVersionsBeforeReplay)

    const currentResponse = await scopedApiRequest(
      request,
      scenario,
      'GET',
      `/api/finoo_intermediaries/admin/bulk-assignments?dealIds=${selection}`,
    )
    const current = (await readJsonSafe<Preflight>(currentResponse))!
    const noOpResponse = await scopedApiRequest(
      request,
      scenario,
      'POST',
      '/api/finoo_intermediaries/admin/bulk-assignments',
      {
        intermediaryCustomerUserId: target.id,
        confirmReassign: false,
        deals: current.deals.map((deal) => ({
          id: deal.id,
          updatedAt: deal.updatedAt,
          assignmentId: deal.assignment?.id ?? null,
          assignmentUpdatedAt: deal.assignment?.updatedAt ?? null,
        })),
      },
    )
    expect(noOpResponse.status()).toBe(200)
    expect(await readJsonSafe(noOpResponse)).toMatchObject({ affectedCount: 0, unchangedCount: 2 })
  } finally {
    await cleanupScenario(request, scenario)
  }
})
