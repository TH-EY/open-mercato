import { randomUUID } from 'node:crypto'
import { expect, test, type APIResponse } from '@playwright/test'
import { portalCookieHeaders, portalLogin } from '@open-mercato/core/helpers/integration/customerAccountsFixtures'
import {
  cleanupScenario,
  createCustomerUser,
  createFieldDefinition,
  createScenario,
  deleteFieldDefinition,
  inviteIntermediary,
  listDirectory,
  queryDatabase,
  runLifecycleAction,
  scopedApiRequest,
  seedAssignment,
  type Scenario,
} from './helpers'

const portalDefinitions = [
  { entityId: 'customers:customer_deal', key: 'turnover', kind: 'integer' },
  { entityId: 'customers:customer_deal', key: 'arrears', kind: 'boolean' },
  { entityId: 'customers:customer_company_profile', key: 'business_start_date', kind: 'date' },
  {
    entityId: 'customers:customer_company_profile',
    key: 'industry',
    kind: 'dictionary',
    configJson: { label: 'Industry', dictionaryId: '11111111-1111-4111-8111-111111111111' },
  },
  { entityId: 'customers:customer_person_profile', key: 'mobile', kind: 'text' },
] as const

function responseId(body: unknown): string {
  if (!body || typeof body !== 'object') throw new Error('[internal] Fixture response is not an object')
  for (const [key, value] of Object.entries(body)) {
    if (['id', 'dealId', 'entityId', 'pipelineId', 'stageId'].includes(key) && typeof value === 'string') return value
    if (value && typeof value === 'object') {
      try { return responseId(value) } catch { continue }
    }
  }
  throw new Error('[internal] Fixture response has no id')
}

async function createdId(response: APIResponse): Promise<string> {
  expect(response.ok(), await response.text()).toBeTruthy()
  return responseId(await response.json())
}

test('TC-FINOO-INT-MGMT-010 related counts, shared Active predicate, and portal isolation', async ({ request }) => {
  let scenario: Scenario | null = null
  try {
    scenario = await createScenario(request, 'TC-FINOO-INT-MGMT-010')
    for (const definition of portalDefinitions) {
      await createFieldDefinition(request, scenario, definition)
    }
    const user = await createCustomerUser(request, scenario)
    const linked = await inviteIntermediary(request, scenario)
    await seedAssignment({ scenario, customerUserId: user.id })
    await seedAssignment({ scenario, customerUserId: user.id })
    await seedAssignment({ scenario, customerUserId: user.id, deleted: true })
    expect((await listDirectory(request, scenario)).items[0]?.relatedDeals).toBe(2)

    const pipelineId = await createdId(await scopedApiRequest(request, scenario, 'POST', '/api/customers/pipelines', {
      name: `TC-010 pipeline ${randomUUID().slice(0, 8)}`,
    }))
    const stageId = await createdId(await scopedApiRequest(request, scenario, 'POST', '/api/customers/pipeline-stages', {
      pipelineId,
      label: 'Sent To Intermediaries',
      order: 1,
    }))
    const companyId = await createdId(await scopedApiRequest(request, scenario, 'POST', '/api/customers/companies', {
      displayName: `TC-010 company ${randomUUID().slice(0, 8)}`,
    }))
    const dealId = await createdId(await scopedApiRequest(request, scenario, 'POST', '/api/customers/deals', {
      title: `TC-010 portal deal ${randomUUID().slice(0, 8)}`,
      description: 'staff-only description must not leak',
      pipelineId,
      pipelineStageId: stageId,
      companyIds: [companyId],
    }))
    const assignmentId = randomUUID()
    await queryDatabase(
      `insert into finoo_intermediary_assignments
       (id,tenant_id,organization_id,deal_id,intermediary_customer_user_id,intermediary_role_id,
        eligible_stage_id,partner_status,assigned_by_user_id,created_at,updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,'new',$8,now(),now())`,
      [assignmentId, scenario.tenantId, scenario.organizationId, dealId, user.id, scenario.intermediaryRoleId, stageId, scenario.staffUserId],
    )
    const session = await portalLogin(request, { email: user.email, password: user.password, tenantId: scenario.tenantId })
    const portalHeaders = portalCookieHeaders(session, { 'Content-Type': 'application/json' })
    const portalDetail = await request.get(`/api/finoo_intermediaries/portal/deals/${dealId}`, { headers: portalHeaders })
    const portalDetailBody = await portalDetail.text()
    expect(portalDetail.status(), portalDetailBody).toBe(200)
    expect(portalDetailBody).not.toContain('staff-only description must not leak')
    const note = await request.post(`/api/finoo_intermediaries/portal/deals/${dealId}/notes`, {
      headers: portalHeaders,
      data: { body: 'portal-private note' },
    })
    expect(note.status()).toBe(201)
    const activity = await request.get(`/api/finoo_intermediaries/portal/deals/${dealId}/activities`, { headers: portalHeaders })
    expect(activity.status()).toBe(200)

    const picker = await scopedApiRequest(request, scenario, 'GET', '/api/finoo_intermediaries/admin/intermediaries')
    expect(((await picker.json()) as { items: Array<{ id: string }> }).items.map((item) => item.id)).toContain(user.id)
    const inactive = await runLifecycleAction(request, scenario, linked.body.item, 'deactivate')
    expect((await listDirectory(request, scenario)).items[0]?.relatedDeals).toBe(3)
    const inactivePicker = await scopedApiRequest(request, scenario, 'GET', '/api/finoo_intermediaries/admin/intermediaries')
    expect(((await inactivePicker.json()) as { items: Array<{ id: string }> }).items.map((item) => item.id)).not.toContain(user.id)
    const directAssignment = await scopedApiRequest(request, scenario, 'POST', '/api/finoo_intermediaries/admin/assignments', {
      dealId: randomUUID(), intermediaryCustomerUserId: user.id,
    })
    expect([400, 404, 409, 422]).toContain(directAssignment.status())
    const activeAgain = await runLifecycleAction(request, scenario, inactive.body.item, 'reactivate')
    expect(activeAgain.body.item.status).toBe('active')
    expect((await listDirectory(request, scenario)).items[0]?.relatedDeals).toBe(3)
  } finally {
    if (scenario) {
      for (const definition of [...portalDefinitions].reverse()) {
        await deleteFieldDefinition(request, scenario, definition.entityId, definition.key)
      }
    }
    await cleanupScenario(request, scenario)
  }
})
