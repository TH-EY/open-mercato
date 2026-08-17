import { randomUUID } from 'node:crypto'
import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import {
  createOrganizationFixture,
  deleteOrganizationIfExists,
} from '@open-mercato/core/helpers/integration/authFixtures'
import {
  createCustomerRoleFixture,
  createCustomerUserFixture,
  deleteCustomerRoleFixture,
  deleteCustomerUserFixture,
  portalCookieHeaders,
  portalLogin,
  type CustomerUserFixture,
  type PortalSession,
} from '@open-mercato/core/helpers/integration/customerAccountsFixtures'
import {
  createPipelineFixture,
  createPipelineStageFixture,
  deleteEntityByBody,
  deleteEntityIfExists,
} from '@open-mercato/core/helpers/integration/crmFixtures'
import { createDictionaryFixture } from '@open-mercato/core/helpers/integration/dictionariesFixtures'
import {
  expectId,
  getTokenContext,
  readJsonSafe,
} from '@open-mercato/core/helpers/integration/generalFixtures'

const ASSIGNMENTS = '/api/finoo_intermediaries/admin/assignments'
const PORTAL_DEALS = '/api/finoo_intermediaries/portal/deals'
const JSON_HEADERS = { 'Content-Type': 'application/json' }

type Assignment = {
  id: string
  dealId: string
  intermediaryCustomerUserId: string
  intermediaryRoleId: string
  eligibleStageId: string
  partnerStatus: 'new' | 'in_progress' | 'done'
  updatedAt: string
}

type DealBundle = {
  companyId: string
  companyProfileId: string
  personId: string
  personProfileId: string
  dealId: string
}

type SuiteState = {
  token: string
  tenantId: string
  organizationId: string
  organizationSlug: string
  roleId: string
  wildcardRoleId: string
  noFeatureRoleId: string
  firstUser: CustomerUserFixture
  secondUser: CustomerUserFixture
  wildcardUser: CustomerUserFixture
  noFeatureUser: CustomerUserFixture
  firstSession: PortalSession
  secondSession: PortalSession
  wildcardSession: PortalSession
  noFeatureSession: PortalSession
  siblingOrganizationId: string
  pipelineId: string
  eligibleStageId: string
  ineligibleStageId: string
  dictionaryId: string
  dictionaryEntryId: string
}

type PortalDeal = {
  id: string
  assignmentId: string
  updatedAt: string
  companyName: string | null
  companyPhone: string | null
  personMobile: string | null
  personEmail: string | null
  turnover: number | null
  businessStartDate: string | null
  arrears: boolean | null
  industry: string | null
  partnerStatus: 'new' | 'in_progress' | 'done'
}

let state: SuiteState
const createdDeals: DealBundle[] = []

async function queryTestDatabase<T extends Record<string, unknown>>(
  sql: string,
  values: unknown[],
): Promise<T[]> {
  const { Client } = await import('pg')
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is required for the ephemeral integration test')
  const client = new Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    const result = await client.query(sql, values)
    return result.rows as T[]
  } finally {
    await client.end()
  }
}

async function createDefinition(
  request: APIRequestContext,
  token: string,
  input: { entityId: string; key: string; kind: string; configJson: Record<string, unknown> },
) {
  const response = await apiRequest(request, 'POST', '/api/entities/definitions', {
    token,
    data: input,
  })
  expect(response.status(), `definition ${input.entityId}.${input.key} should be created`).toBe(200)
}

async function deleteDefinition(
  request: APIRequestContext,
  token: string,
  entityId: string,
  key: string,
) {
  await apiRequest(request, 'DELETE', '/api/entities/definitions', {
    token,
    data: { entityId, key },
  }).catch(() => undefined)
}

async function createDictionaryEntry(
  request: APIRequestContext,
  token: string,
  dictionaryId: string,
) {
  const response = await apiRequest(
    request,
    'POST',
    `/api/dictionaries/${encodeURIComponent(dictionaryId)}/entries`,
    { token, data: { value: 'finance', label: 'Finance' } },
  )
  expect(response.status()).toBe(201)
  return expectId((await readJsonSafe<{ id?: string }>(response))?.id, 'dictionary entry id')
}

async function createDealBundle(
  request: APIRequestContext,
  input: { stageId?: string; suffix?: string } = {},
): Promise<DealBundle> {
  const suffix = input.suffix ?? randomUUID().slice(0, 8)
  const companyResponse = await apiRequest(request, 'POST', '/api/customers/companies', {
    token: state.token,
    data: {
      displayName: `Intermediary Company ${suffix}`,
      primaryPhone: '+48123456789',
    },
  })
  expect(companyResponse.status()).toBe(201)
  const companyId = expectId(
    (await readJsonSafe<{ id?: string }>(companyResponse))?.id,
    'company id',
  )

  const personResponse = await apiRequest(request, 'POST', '/api/customers/people', {
    token: state.token,
    data: {
      firstName: 'Intermediary',
      lastName: suffix,
      displayName: `Intermediary Person ${suffix}`,
      primaryEmail: `intermediary-person-${suffix}@test.local`,
    },
  })
  expect(personResponse.status()).toBe(201)
  const personId = expectId(
    (await readJsonSafe<{ id?: string }>(personResponse))?.id,
    'person id',
  )

  const dealResponse = await apiRequest(request, 'POST', '/api/customers/deals', {
    token: state.token,
    data: {
      title: `Intermediary Deal ${suffix}`,
      description: `private staff description ${suffix}`,
      pipelineId: state.pipelineId,
      pipelineStageId: input.stageId ?? state.eligibleStageId,
      companyIds: [companyId],
      personIds: [personId],
      primaryPersonEntityId: personId,
    },
  })
  expect(dealResponse.status()).toBe(201)
  const dealId = expectId((await readJsonSafe<{ id?: string }>(dealResponse))?.id, 'deal id')
  const profileRows = await queryTestDatabase<{
    company_profile_id: string
    person_profile_id: string
  }>(
    `select
       (select id from customer_companies where entity_id = $1) as company_profile_id,
       (select id from customer_people where entity_id = $2) as person_profile_id`,
    [companyId, personId],
  )
  const companyProfileId = expectId(profileRows[0]?.company_profile_id, 'company profile id')
  const personProfileId = expectId(profileRows[0]?.person_profile_id, 'person profile id')
  await queryTestDatabase(
    `insert into custom_field_values
       (id, entity_id, record_id, organization_id, tenant_id, field_key, value_text, value_int, value_bool, created_at)
     values
       (gen_random_uuid(), 'customers:customer_deal', $1, $6, $7, 'turnover', null, 125000, null, now()),
       (gen_random_uuid(), 'customers:customer_deal', $1, $6, $7, 'arrears', null, null, false, now()),
       (gen_random_uuid(), 'customers:customer_company_profile', $2, $6, $7, 'business_start_date', '2020-02-03', null, null, now()),
       (gen_random_uuid(), 'customers:customer_company_profile', $2, $6, $7, 'industry', $4, null, null, now()),
       (gen_random_uuid(), 'customers:customer_person_profile', $3, $6, $7, 'mobile', $5, null, null, now())`,
    [
      dealId,
      companyProfileId,
      personProfileId,
      state.dictionaryEntryId,
      '+48987654321',
      state.organizationId,
      state.tenantId,
    ],
  )
  const bundle = { companyId, companyProfileId, personId, personProfileId, dealId }
  createdDeals.push(bundle)
  return bundle
}

async function createAssignment(
  request: APIRequestContext,
  dealId: string,
  intermediaryCustomerUserId = state.firstUser.id,
): Promise<Assignment> {
  const response = await apiRequest(request, 'POST', ASSIGNMENTS, {
    token: state.token,
    data: { dealId, intermediaryCustomerUserId },
  })
  expect(response.status(), `assignment create response: ${await response.text()}`).toBe(201)
  const body = await readJsonSafe<{ assignment?: Assignment }>(response)
  return body?.assignment as Assignment
}

async function registerActiveIntermediary(
  request: APIRequestContext,
  user: CustomerUserFixture,
  firstName: string,
  lastName: string,
) {
  const response = await apiRequest(request, 'POST', '/api/finoo_intermediaries/admin/directory/invite', {
    token: state.token,
    data: { email: user.email, firstName, lastName },
  })
  expect(response.status(), `active intermediary directory response: ${await response.text()}`).toBe(200)
}

async function portalRequest(
  request: APIRequestContext,
  session: PortalSession,
  method: string,
  path: string,
  data?: unknown,
): Promise<APIResponse> {
  return request.fetch(path, {
    method,
    headers: portalCookieHeaders(session, JSON_HEADERS),
    data,
  })
}

async function readPortalDeal(
  request: APIRequestContext,
  session: PortalSession,
  dealId: string,
): Promise<{ response: APIResponse; deal: PortalDeal | null; body: Record<string, unknown> | null }> {
  const response = await portalRequest(request, session, 'GET', `${PORTAL_DEALS}/${dealId}`)
  const body = await readJsonSafe<{ deal?: PortalDeal } & Record<string, unknown>>(response)
  return { response, deal: body?.deal ?? null, body }
}

async function updateDealStage(request: APIRequestContext, dealId: string, stageId: string) {
  const response = await apiRequest(request, 'PUT', '/api/customers/deals', {
    token: state.token,
    data: { id: dealId, pipelineStageId: stageId },
  })
  expect(response.status()).toBe(200)
}

async function deleteAssignment(request: APIRequestContext, assignment: Assignment) {
  await apiRequest(request, 'DELETE', `${ASSIGNMENTS}/${assignment.id}`, {
    token: state.token,
    data: { expectedUpdatedAt: assignment.updatedAt },
  }).catch(() => undefined)
}

test.describe.serial('THOM-90 FINOO intermediary portal', () => {
  test.describe.configure({ retries: 0 })
  test.beforeAll(async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const { tenantId, organizationId } = getTokenContext(token)
    const stamp = randomUUID().slice(0, 8)
    const role = await createCustomerRoleFixture(request, token, {
      name: 'Intermediary',
      slug: 'intermediary',
      features: ['portal.finoo_intermediaries.view'],
    })
    const wildcardRole = await createCustomerRoleFixture(request, token, {
      name: `Wildcard ${stamp}`,
      slug: `wildcard-${stamp}`,
      features: ['portal.*'],
    })
    const noFeatureRole = await createCustomerRoleFixture(request, token, {
      name: `No feature ${stamp}`,
      slug: `no-feature-${stamp}`,
      features: [],
    })
    const firstUser = await createCustomerUserFixture(request, token, { roleIds: [role.id] })
    const secondUser = await createCustomerUserFixture(request, token, { roleIds: [role.id] })
    const wildcardUser = await createCustomerUserFixture(request, token, { roleIds: [wildcardRole.id] })
    const noFeatureUser = await createCustomerUserFixture(request, token, { roleIds: [noFeatureRole.id] })
    const firstSession = await portalLogin(request, {
      email: firstUser.email,
      password: firstUser.password,
      tenantId,
    })
    const secondSession = await portalLogin(request, {
      email: secondUser.email,
      password: secondUser.password,
      tenantId,
    })
    const wildcardSession = await portalLogin(request, {
      email: wildcardUser.email,
      password: wildcardUser.password,
      tenantId,
    })
    const noFeatureSession = await portalLogin(request, {
      email: noFeatureUser.email,
      password: noFeatureUser.password,
      tenantId,
    })
    const siblingOrganizationId = await createOrganizationFixture(request, token, {
      name: `THOM-90 sibling ${stamp}`,
      tenantId,
    })
    const pipelineId = await createPipelineFixture(request, token, { name: 'Web Form Sales Pipeline' })
    const eligibleStageId = await createPipelineStageFixture(request, token, {
      pipelineId,
      label: 'Sent To Partners',
      order: 1,
    })
    const ineligibleStageId = await createPipelineStageFixture(request, token, {
      pipelineId,
      label: 'Sent To Intermediaries',
      order: 2,
    })
    const dictionaryId = await createDictionaryFixture(request, token, {
      key: `intermediary_industry_${stamp}`,
      name: `Intermediary Industry ${stamp}`,
    })
    const dictionaryEntryId = await createDictionaryEntry(request, token, dictionaryId)

    await createDefinition(request, token, {
      entityId: 'customers:customer_deal',
      key: 'turnover',
      kind: 'integer',
      configJson: { label: 'Turnover' },
    })
    await createDefinition(request, token, {
      entityId: 'customers:customer_deal',
      key: 'arrears',
      kind: 'boolean',
      configJson: { label: 'Arrears' },
    })
    await createDefinition(request, token, {
      entityId: 'customers:customer_company_profile',
      key: 'business_start_date',
      kind: 'date',
      configJson: { label: 'Business start date' },
    })
    await createDefinition(request, token, {
      entityId: 'customers:customer_company_profile',
      key: 'industry',
      kind: 'dictionary',
      configJson: { label: 'Industry', dictionaryId },
    })
    await createDefinition(request, token, {
      entityId: 'customers:customer_person_profile',
      key: 'mobile',
      kind: 'text',
      configJson: { label: 'Mobile' },
    })

    const organizationRows = await queryTestDatabase<{ slug: string }>(
      'select slug from organizations where id = $1',
      [organizationId],
    )
    const organizationSlug = organizationRows[0]?.slug ?? 'acme'
    state = {
      token,
      tenantId,
      organizationId,
      organizationSlug,
      roleId: role.id,
      wildcardRoleId: wildcardRole.id,
      noFeatureRoleId: noFeatureRole.id,
      firstUser,
      secondUser,
      wildcardUser,
      noFeatureUser,
      firstSession,
      secondSession,
      wildcardSession,
      noFeatureSession,
      siblingOrganizationId,
      pipelineId,
      eligibleStageId,
      ineligibleStageId,
      dictionaryId,
      dictionaryEntryId,
    }
    await registerActiveIntermediary(request, firstUser, 'First', 'Intermediary')
    await registerActiveIntermediary(request, secondUser, 'Second', 'Intermediary')
  })

  test.afterAll(async ({ request }) => {
    for (const bundle of [...createdDeals].reverse()) {
      await queryTestDatabase(
        `delete from finoo_intermediary_notes
         where assignment_id in (select id from finoo_intermediary_assignments where deal_id = $1)`,
        [bundle.dealId],
      ).catch(() => undefined)
      await queryTestDatabase(
        'delete from finoo_intermediary_assignments where deal_id = $1',
        [bundle.dealId],
      ).catch(() => undefined)
      await queryTestDatabase(
        'delete from custom_field_values where record_id = any($1::text[])',
        [[bundle.dealId, bundle.companyProfileId, bundle.personProfileId]],
      ).catch(() => undefined)
      await deleteEntityIfExists(request, state.token, '/api/customers/deals', bundle.dealId)
      await deleteEntityIfExists(request, state.token, '/api/customers/people', bundle.personId)
      await deleteEntityIfExists(request, state.token, '/api/customers/companies', bundle.companyId)
    }
    for (const [entityId, key] of [
      ['customers:customer_person_profile', 'mobile'],
      ['customers:customer_company_profile', 'industry'],
      ['customers:customer_company_profile', 'business_start_date'],
      ['customers:customer_deal', 'arrears'],
      ['customers:customer_deal', 'turnover'],
    ] as const) {
      await deleteDefinition(request, state.token, entityId, key)
    }
    await deleteEntityByBody(request, state.token, '/api/customers/pipeline-stages', state.ineligibleStageId)
    await deleteEntityByBody(request, state.token, '/api/customers/pipeline-stages', state.eligibleStageId)
    await deleteEntityByBody(request, state.token, '/api/customers/pipelines', state.pipelineId)
    await deleteEntityIfExists(request, state.token, '/api/dictionaries', state.dictionaryId)
    await queryTestDatabase(
      'delete from finoo_intermediaries where tenant_id = $1 and organization_id = $2',
      [state.tenantId, state.organizationId],
    )
    await deleteCustomerUserFixture(request, state.token, state.wildcardUser.id)
    await deleteCustomerUserFixture(request, state.token, state.noFeatureUser.id)
    await deleteCustomerUserFixture(request, state.token, state.secondUser.id)
    await deleteCustomerUserFixture(request, state.token, state.firstUser.id)
    await deleteCustomerRoleFixture(request, state.token, state.roleId)
    await deleteCustomerRoleFixture(request, state.token, state.wildcardRoleId)
    await deleteCustomerRoleFixture(request, state.token, state.noFeatureRoleId)
    await deleteOrganizationIfExists(request, state.token, state.siblingOrganizationId)
  })

  test('TC-FINOO-INT-001 creates an exact-stage assignment without mutating the Deal', async ({ request }) => {
    const bundle = await createDealBundle(request, { suffix: '001' })
    const before = await readJsonSafe<Record<string, unknown>>(
      await apiRequest(request, 'GET', `/api/customers/deals/${bundle.dealId}`, { token: state.token }),
    )
    const assignment = await createAssignment(request, bundle.dealId)
    const after = await readJsonSafe<Record<string, unknown>>(
      await apiRequest(request, 'GET', `/api/customers/deals/${bundle.dealId}`, { token: state.token }),
    )
    expect(assignment.dealId).toBe(bundle.dealId)
    expect(assignment.intermediaryRoleId).toBe(state.roleId)
    expect(assignment.eligibleStageId).toBe(state.eligibleStageId)
    expect(after?.pipelineStageId).toBe(before?.pipelineStageId)
    expect(after?.customFields).toEqual(before?.customFields)
    expect(after?.description).toBe(before?.description)
    await deleteAssignment(request, assignment)
  })

  test('TC-FINOO-INT-002 rejects ineligible stages, wrong roles, and duplicate assignments', async ({ request }) => {
    const ambiguousStageId = await createPipelineStageFixture(request, state.token, {
      pipelineId: state.pipelineId,
      label: 'sent to partners',
      order: 3,
    })
    const ambiguous = await createDealBundle(request, { suffix: '002ambiguous' })
    const ambiguousResponse = await apiRequest(request, 'POST', ASSIGNMENTS, {
      token: state.token,
      data: { dealId: ambiguous.dealId, intermediaryCustomerUserId: state.firstUser.id },
    })
    expect(ambiguousResponse.status()).toBe(422)
    await deleteEntityByBody(request, state.token, '/api/customers/pipeline-stages', ambiguousStageId)

    const ineligible = await createDealBundle(request, { stageId: state.ineligibleStageId, suffix: '002a' })
    const ineligibleResponse = await apiRequest(request, 'POST', ASSIGNMENTS, {
      token: state.token,
      data: { dealId: ineligible.dealId, intermediaryCustomerUserId: state.firstUser.id },
    })
    expect(ineligibleResponse.status()).toBe(422)

    const eligible = await createDealBundle(request, { suffix: '002b' })
    const wrongRoleResponse = await apiRequest(request, 'POST', ASSIGNMENTS, {
      token: state.token,
      data: { dealId: eligible.dealId, intermediaryCustomerUserId: state.wildcardUser.id },
    })
    expect(wrongRoleResponse.status()).toBe(404)
    const duplicateResponses = await Promise.all([
      apiRequest(request, 'POST', ASSIGNMENTS, {
        token: state.token,
        data: { dealId: eligible.dealId, intermediaryCustomerUserId: state.firstUser.id },
      }),
      apiRequest(request, 'POST', ASSIGNMENTS, {
        token: state.token,
        data: { dealId: eligible.dealId, intermediaryCustomerUserId: state.secondUser.id },
      }),
    ])
    expect(duplicateResponses.map((response) => response.status()).sort()).toEqual([201, 409])
    const createdResponse = duplicateResponses.find((response) => response.status() === 201)!
    const assignment = (await readJsonSafe<{ assignment: Assignment }>(createdResponse))?.assignment as Assignment
    await deleteAssignment(request, assignment)
  })

  test('TC-FINOO-INT-003 reassigns with optimistic locking and immediately changes access', async ({ request }) => {
    const bundle = await createDealBundle(request, { suffix: '003' })
    const assignment = await createAssignment(request, bundle.dealId)
    const stale = await apiRequest(request, 'PUT', `${ASSIGNMENTS}/${assignment.id}`, {
      token: state.token,
      data: {
        intermediaryCustomerUserId: state.secondUser.id,
        expectedUpdatedAt: new Date(0).toISOString(),
      },
    })
    expect(stale.status()).toBe(409)
    await updateDealStage(request, bundle.dealId, state.ineligibleStageId)
    const ineligibleUpdate = await apiRequest(request, 'PUT', `${ASSIGNMENTS}/${assignment.id}`, {
      token: state.token,
      data: {
        intermediaryCustomerUserId: state.secondUser.id,
        expectedUpdatedAt: assignment.updatedAt,
      },
    })
    expect(ineligibleUpdate.status()).toBe(422)
    await updateDealStage(request, bundle.dealId, state.eligibleStageId)
    const update = await apiRequest(request, 'PUT', `${ASSIGNMENTS}/${assignment.id}`, {
      token: state.token,
      data: {
        intermediaryCustomerUserId: state.secondUser.id,
        expectedUpdatedAt: assignment.updatedAt,
      },
    })
    expect(update.status()).toBe(200)
    const updated = (await readJsonSafe<{ assignment: Assignment }>(update))?.assignment as Assignment
    expect((await readPortalDeal(request, state.firstSession, bundle.dealId)).response.status()).toBe(404)
    expect((await readPortalDeal(request, state.secondSession, bundle.dealId)).response.status()).toBe(200)
    const actionLogResponse = await apiRequest(
      request,
      'GET',
      `/api/audit_logs/audit-logs/actions?resourceKind=finoo_intermediaries.assignment&resourceId=${assignment.id}`,
      { token: state.token },
    )
    expect(actionLogResponse.status()).toBe(200)
    const actionLogs = await readJsonSafe<{
      items: Array<{ commandId: string; executionState: string; undoToken: string | null }>
    }>(actionLogResponse)
    const updateLog = actionLogs?.items.find((item) => (
      item.commandId === 'finoo_intermediaries.assignment.update'
      && item.executionState === 'done'
    ))
    expect(updateLog?.undoToken).toEqual(expect.any(String))
    const undo = await apiRequest(
      request,
      'POST',
      '/api/audit_logs/audit-logs/actions/undo',
      { token: state.token, data: { undoToken: updateLog?.undoToken } },
    )
    expect(undo.status()).toBe(200)
    expect((await readPortalDeal(request, state.firstSession, bundle.dealId)).response.status()).toBe(200)
    expect((await readPortalDeal(request, state.secondSession, bundle.dealId)).response.status()).toBe(404)
    const restoredResponse = await apiRequest(
      request,
      'GET',
      `${ASSIGNMENTS}?dealId=${bundle.dealId}`,
      { token: state.token },
    )
    const restored = (await readJsonSafe<{ assignment: Assignment }>(restoredResponse))?.assignment
    await deleteAssignment(request, restored ?? updated)
  })

  test('TC-FINOO-INT-004 returns only the typed canonical portal projection', async ({ request }) => {
    const bundle = await createDealBundle(request, { suffix: '004' })
    const assignment = await createAssignment(request, bundle.dealId)
    const { response, deal } = await readPortalDeal(request, state.firstSession, bundle.dealId)
    expect(response.status()).toBe(200)
    expect(deal).toEqual({
      id: bundle.dealId,
      assignmentId: assignment.id,
      updatedAt: assignment.updatedAt,
      companyName: 'Intermediary Company 004',
      companyPhone: '+48123456789',
      personMobile: '+48987654321',
      personEmail: 'intermediary-person-004@test.local',
      turnover: 125000,
      businessStartDate: '2020-02-03',
      arrears: false,
      industry: 'Finance',
      partnerStatus: 'new',
    })
    expect(Object.keys(deal ?? {}).sort()).toEqual([
      'arrears',
      'assignmentId',
      'businessStartDate',
      'companyName',
      'companyPhone',
      'id',
      'industry',
      'partnerStatus',
      'personEmail',
      'personMobile',
      'turnover',
      'updatedAt',
    ])
    await queryTestDatabase(
      `update custom_field_values
       set value_text = 'legacy-industry-value'
       where entity_id = 'customers:customer_company_profile'
         and record_id = $1
         and field_key = 'industry'
         and organization_id = $2
         and tenant_id = $3`,
      [bundle.companyProfileId, state.organizationId, state.tenantId],
    )
    try {
      const listResponse = await portalRequest(request, state.firstSession, 'GET', PORTAL_DEALS)
      expect(listResponse.status()).toBe(200)
      const listBody = await readJsonSafe<{ items?: PortalDeal[] }>(listResponse)
      expect(listBody?.items?.find((item) => item.id === bundle.dealId)).toMatchObject({
        id: bundle.dealId,
        industry: null,
      })
    } finally {
      await queryTestDatabase(
        `update custom_field_values
         set value_text = $1
         where entity_id = 'customers:customer_company_profile'
           and record_id = $2
           and field_key = 'industry'
           and organization_id = $3
           and tenant_id = $4`,
        [state.dictionaryEntryId, bundle.companyProfileId, state.organizationId, state.tenantId],
      )
    }
    const replacementCompanyResponse = await apiRequest(request, 'POST', '/api/customers/companies', {
      token: state.token,
      data: {
        displayName: 'Intermediary Company 004 replacement',
        primaryPhone: '+48111222333',
      },
    })
    expect(replacementCompanyResponse.status()).toBe(201)
    const replacementCompanyId = expectId(
      (await readJsonSafe<{ id?: string }>(replacementCompanyResponse))?.id,
      'replacement company id',
    )
    try {
      await queryTestDatabase(
        `insert into customer_deal_companies (id, deal_id, company_entity_id, created_at)
         values (gen_random_uuid(), $1, $2, now())`,
        [bundle.dealId, replacementCompanyId],
      )
      await queryTestDatabase(
        'update customer_entities set deleted_at = now() where id = $1 and organization_id = $2 and tenant_id = $3',
        [bundle.companyId, state.organizationId, state.tenantId],
      )
      const replacementProjection = await readPortalDeal(request, state.firstSession, bundle.dealId)
      expect(replacementProjection.response.status()).toBe(200)
      expect(replacementProjection.deal).toMatchObject({
        companyName: 'Intermediary Company 004 replacement',
        companyPhone: '+48111222333',
      })
    } finally {
      await queryTestDatabase(
        'update customer_entities set deleted_at = null where id = $1 and organization_id = $2 and tenant_id = $3',
        [bundle.companyId, state.organizationId, state.tenantId],
      )
      await queryTestDatabase(
        'delete from customer_deal_companies where deal_id = $1 and company_entity_id = $2',
        [bundle.dealId, replacementCompanyId],
      )
      await deleteEntityIfExists(request, state.token, '/api/customers/companies', replacementCompanyId)
    }
    await deleteAssignment(request, assignment)
  })

  test('TC-FINOO-INT-005 gates access by captured stage UUID, not later stage label', async ({ request }) => {
    const bundle = await createDealBundle(request, { suffix: '005' })
    let assignment = await createAssignment(request, bundle.dealId)
    await updateDealStage(request, bundle.dealId, state.ineligibleStageId)
    expect((await readPortalDeal(request, state.firstSession, bundle.dealId)).response.status()).toBe(404)
    await updateDealStage(request, bundle.dealId, state.eligibleStageId)
    expect((await readPortalDeal(request, state.firstSession, bundle.dealId)).response.status()).toBe(200)
    try {
      const rename = await apiRequest(request, 'PUT', '/api/customers/pipeline-stages', {
        token: state.token,
        data: { id: state.eligibleStageId, label: 'Renamed after assignment' },
      })
      expect(rename.status()).toBe(200)
      expect((await readPortalDeal(request, state.firstSession, bundle.dealId)).response.status()).toBe(200)
      const reassign = await apiRequest(request, 'PUT', `${ASSIGNMENTS}/${assignment.id}`, {
        token: state.token,
        data: {
          intermediaryCustomerUserId: state.secondUser.id,
          expectedUpdatedAt: assignment.updatedAt,
        },
      })
      expect(reassign.status(), `renamed-stage reassignment response: ${await reassign.text()}`).toBe(200)
      assignment = (await readJsonSafe<{ assignment: Assignment }>(reassign))?.assignment as Assignment
      expect((await readPortalDeal(request, state.firstSession, bundle.dealId)).response.status()).toBe(404)
      expect((await readPortalDeal(request, state.secondSession, bundle.dealId)).response.status()).toBe(200)
      await queryTestDatabase(
        'update customer_roles set slug = $1 where id = $2 and organization_id = $3 and tenant_id = $4',
        [`renamed-intermediary-${randomUUID().slice(0, 8)}`, state.roleId, state.organizationId, state.tenantId],
      )
      try {
        expect((await readPortalDeal(request, state.secondSession, bundle.dealId)).response.status()).toBe(200)
      } finally {
        await queryTestDatabase(
          'update customer_roles set slug = $1 where id = $2 and organization_id = $3 and tenant_id = $4',
          ['intermediary', state.roleId, state.organizationId, state.tenantId],
        )
      }
    } finally {
      const restore = await apiRequest(request, 'PUT', '/api/customers/pipeline-stages', {
        token: state.token,
        data: { id: state.eligibleStageId, label: 'Sent To Partners' },
      })
      expect(restore.status()).toBe(200)
    }
    await deleteAssignment(request, assignment)
  })

  test('TC-FINOO-INT-006 enforces adjacent partner-status transitions and stale writes', async ({ request }) => {
    const bundle = await createDealBundle(request, { suffix: '006' })
    const assignment = await createAssignment(request, bundle.dealId)
    const skipped = await portalRequest(request, state.firstSession, 'PUT', `${PORTAL_DEALS}/${bundle.dealId}/status`, {
      status: 'done',
      expectedUpdatedAt: assignment.updatedAt,
    })
    expect(skipped.status()).toBe(409)
    const concurrent = await Promise.all([
      portalRequest(request, state.firstSession, 'PUT', `${PORTAL_DEALS}/${bundle.dealId}/status`, {
        status: 'in_progress',
        expectedUpdatedAt: assignment.updatedAt,
      }),
      portalRequest(request, state.firstSession, 'PUT', `${PORTAL_DEALS}/${bundle.dealId}/status`, {
        status: 'in_progress',
        expectedUpdatedAt: assignment.updatedAt,
      }),
    ])
    expect(concurrent.map((response) => response.status()).sort()).toEqual([200, 409])
    const first = concurrent.find((response) => response.status() === 200)!
    const firstBody = await readJsonSafe<{ updatedAt: string }>(first)
    const stale = await portalRequest(request, state.firstSession, 'PUT', `${PORTAL_DEALS}/${bundle.dealId}/status`, {
      status: 'done',
      expectedUpdatedAt: assignment.updatedAt,
    })
    expect(stale.status()).toBe(409)
    const second = await portalRequest(request, state.firstSession, 'PUT', `${PORTAL_DEALS}/${bundle.dealId}/status`, {
      status: 'done',
      expectedUpdatedAt: firstBody?.updatedAt,
    })
    expect(second.status()).toBe(200)
    const secondBody = await readJsonSafe<{ updatedAt: string }>(second)
    await deleteAssignment(request, { ...assignment, updatedAt: secondBody?.updatedAt ?? assignment.updatedAt })
  })

  test('TC-FINOO-INT-007 encrypts author-scoped notes and enforces stale conflicts', async ({ request }) => {
    const bundle = await createDealBundle(request, { suffix: '007' })
    const assignment = await createAssignment(request, bundle.dealId)
    const plaintext = '<script>alert(1)</script> private intermediary note'
    const create = await portalRequest(request, state.firstSession, 'POST', `${PORTAL_DEALS}/${bundle.dealId}/notes`, {
      body: plaintext,
    })
    expect(create.status()).toBe(201)
    const note = (await readJsonSafe<{ note: { id: string; body: string; updatedAt: string } }>(create))?.note
    expect(note?.body).toBe(plaintext)
    const storedRows = await queryTestDatabase<{ body: string }>(
      'select body from finoo_intermediary_notes where id = $1',
      [note?.id],
    )
    const stored = storedRows[0]?.body ?? ''
    expect(stored).not.toBe(plaintext)
    expect(stored).not.toContain('private intermediary note')
    const audit = await apiRequest(
      request,
      'GET',
      `/api/audit_logs/audit-logs/actions?resourceKind=finoo_intermediaries.note&resourceId=${note?.id}`,
      { token: state.token },
    )
    expect(audit.status()).toBe(200)
    expect(JSON.stringify(await readJsonSafe<Record<string, unknown>>(audit))).not.toContain(plaintext)
    const otherAuthor = await portalRequest(request, state.secondSession, 'GET', `${PORTAL_DEALS}/${bundle.dealId}/notes`)
    expect(otherAuthor.status()).toBe(404)
    const stale = await portalRequest(request, state.firstSession, 'PUT', `${PORTAL_DEALS}/${bundle.dealId}/notes/${note?.id}`, {
      body: 'updated',
      expectedUpdatedAt: new Date(0).toISOString(),
    })
    expect(stale.status()).toBe(409)
    const update = await portalRequest(request, state.firstSession, 'PUT', `${PORTAL_DEALS}/${bundle.dealId}/notes/${note?.id}`, {
      body: 'updated',
      expectedUpdatedAt: note?.updatedAt,
    })
    expect(update.status()).toBe(200)
    const updatedNote = (await readJsonSafe<{ note: { id: string; updatedAt: string } }>(update))?.note
    const createSecond = await portalRequest(request, state.firstSession, 'POST', `${PORTAL_DEALS}/${bundle.dealId}/notes`, {
      body: 'second note',
    })
    expect(createSecond.status()).toBe(201)
    const secondNote = (await readJsonSafe<{ note: { id: string; updatedAt: string } }>(createSecond))?.note
    const assignmentRead = await apiRequest(
      request,
      'GET',
      `${ASSIGNMENTS}?dealId=${bundle.dealId}`,
      { token: state.token },
    )
    expect(assignmentRead.status()).toBe(200)
    const assignmentProjection = await readJsonSafe<{
      notes: Array<{ body: string }>
      notesNextCursor: string | null
    }>(assignmentRead)
    expect(assignmentProjection?.notes.map((item) => item.body).sort()).toEqual(['second note', 'updated'])
    expect(assignmentProjection?.notesNextCursor).toBeNull()
    const staff = await apiRequest(
      request,
      'GET',
      `/api/finoo_intermediaries/admin/assignments/${assignment.id}/notes?pageSize=1`,
      { token: state.token },
    )
    expect(staff.status()).toBe(200)
    const firstStaffPage = await readJsonSafe<{ items: Array<{ body: string }>; nextCursor: string | null }>(staff)
    expect(firstStaffPage?.items).toHaveLength(1)
    expect(firstStaffPage?.nextCursor).toEqual(expect.any(String))
    const secondStaffPageResponse = await apiRequest(
      request,
      'GET',
      `/api/finoo_intermediaries/admin/assignments/${assignment.id}/notes?pageSize=1&cursor=${encodeURIComponent(firstStaffPage?.nextCursor ?? '')}`,
      { token: state.token },
    )
    expect(secondStaffPageResponse.status()).toBe(200)
    const secondStaffPage = await readJsonSafe<{ items: Array<{ body: string }>; nextCursor: string | null }>(secondStaffPageResponse)
    expect([
      ...(firstStaffPage?.items ?? []),
      ...(secondStaffPage?.items ?? []),
    ].map((item) => item.body).sort()).toEqual(['second note', 'updated'])
    expect(secondStaffPage?.nextCursor).toBeNull()

    const reassign = await apiRequest(request, 'PUT', `${ASSIGNMENTS}/${assignment.id}`, {
      token: state.token,
      data: {
        intermediaryCustomerUserId: state.secondUser.id,
        expectedUpdatedAt: assignment.updatedAt,
      },
    })
    expect(reassign.status()).toBe(200)
    const reassigned = (await readJsonSafe<{ assignment: Assignment }>(reassign))?.assignment as Assignment
    const secondUserNotes = await portalRequest(request, state.secondSession, 'GET', `${PORTAL_DEALS}/${bundle.dealId}/notes`)
    expect(secondUserNotes.status()).toBe(200)
    expect((await readJsonSafe<{ items: unknown[] }>(secondUserNotes))?.items).toEqual([])
    expect((await portalRequest(request, state.firstSession, 'GET', `${PORTAL_DEALS}/${bundle.dealId}/notes`)).status()).toBe(404)

    const restore = await apiRequest(request, 'PUT', `${ASSIGNMENTS}/${assignment.id}`, {
      token: state.token,
      data: {
        intermediaryCustomerUserId: state.firstUser.id,
        expectedUpdatedAt: reassigned.updatedAt,
      },
    })
    expect(restore.status()).toBe(200)
    const restored = (await readJsonSafe<{ assignment: Assignment }>(restore))?.assignment as Assignment
    const deleteUpdated = await portalRequest(request, state.firstSession, 'DELETE', `${PORTAL_DEALS}/${bundle.dealId}/notes/${updatedNote?.id}`, {
      expectedUpdatedAt: updatedNote?.updatedAt,
    })
    expect(deleteUpdated.status()).toBe(200)
    const deleteSecond = await portalRequest(request, state.firstSession, 'DELETE', `${PORTAL_DEALS}/${bundle.dealId}/notes/${secondNote?.id}`, {
      expectedUpdatedAt: secondNote?.updatedAt,
    })
    expect(deleteSecond.status()).toBe(200)
    const emptyNotes = await portalRequest(request, state.firstSession, 'GET', `${PORTAL_DEALS}/${bundle.dealId}/notes`)
    expect((await readJsonSafe<{ items: unknown[] }>(emptyNotes))?.items).toEqual([])
    await deleteAssignment(request, restored)
  })

  test('TC-FINOO-INT-008 exposes public activities and excludes team/email/private/body data', async ({ request }) => {
    const bundle = await createDealBundle(request, { suffix: '008' })
    const assignment = await createAssignment(request, bundle.dealId)
    const interactionIds: string[] = []
    for (const input of [
      { interactionType: 'call', title: '<b>Newer occurrence</b>', body: 'secret body', visibility: 'public', occurredAt: '2026-08-12T10:00:00.000Z' },
      { interactionType: 'meeting', title: 'Older occurrence', body: 'second secret body', visibility: 'public', occurredAt: '2026-08-11T10:00:00.000Z' },
      { interactionType: 'meeting', title: 'No occurrence', body: 'third secret body', visibility: 'public', occurredAt: null },
      { interactionType: 'meeting', title: 'Team meeting', body: 'team body', visibility: 'team', occurredAt: '2026-08-13T11:00:00.000Z' },
      { interactionType: 'meeting', title: 'Private meeting', body: 'private body', visibility: 'private', occurredAt: '2026-08-13T10:00:00.000Z' },
      { interactionType: 'email', title: 'Email subject', body: 'email body', visibility: 'public', occurredAt: '2026-08-14T10:00:00.000Z' },
    ]) {
      const response = await apiRequest(request, 'POST', '/api/customers/interactions', {
        token: state.token,
        data: {
          entityId: bundle.personId,
          status: 'done',
          ...input,
        },
      })
      expect(response.status()).toBe(201)
      interactionIds.push(expectId((await readJsonSafe<{ id?: string }>(response))?.id, 'interaction id'))
    }
    const response = await portalRequest(request, state.firstSession, 'GET', `${PORTAL_DEALS}/${bundle.dealId}/activities?pageSize=2`)
    expect(response.status()).toBe(200)
    const firstPage = await readJsonSafe<{
      items: Array<Record<string, unknown>>
      nextCursor: string | null
    }>(response)
    const items = firstPage?.items ?? []
    expect(items).toHaveLength(2)
    expect(firstPage?.nextCursor).toEqual(expect.any(String))
    expect(Object.keys(items[0]).sort()).toEqual(['direction', 'id', 'occurredAt', 'summary', 'type'])
    expect(items.map((item) => item.summary)).toEqual(['Newer occurrence', 'Older occurrence'])
    const secondPageResponse = await portalRequest(
      request,
      state.firstSession,
      'GET',
      `${PORTAL_DEALS}/${bundle.dealId}/activities?pageSize=2&cursor=${encodeURIComponent(firstPage?.nextCursor ?? '')}`,
    )
    expect(secondPageResponse.status()).toBe(200)
    const secondPage = await readJsonSafe<{ items: Array<Record<string, unknown>> }>(secondPageResponse)
    expect(secondPage?.items).toEqual([expect.objectContaining({
      summary: 'No occurrence',
      occurredAt: null,
    })])
    for (const interactionId of interactionIds) {
      await deleteEntityIfExists(request, state.token, '/api/customers/interactions', interactionId)
    }
    await deleteAssignment(request, assignment)
  })

  test('TC-FINOO-INT-009 masks forged and cross-intermediary IDs despite wildcard portal ACL', async ({ request }) => {
    const bundle = await createDealBundle(request, { suffix: '009' })
    const assignment = await createAssignment(request, bundle.dealId)
    const forgedId = randomUUID()
    const crossOrganizationDealId = randomUUID()
    const crossOrganizationAssignmentId = randomUUID()
    await queryTestDatabase(
      `insert into finoo_intermediary_assignments
        (id, tenant_id, organization_id, deal_id, intermediary_customer_user_id,
         intermediary_role_id, eligible_stage_id, partner_status, assigned_by_user_id, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, 'new', $8, now(), now())`,
      [
        crossOrganizationAssignmentId,
        state.tenantId,
        state.siblingOrganizationId,
        crossOrganizationDealId,
        state.firstUser.id,
        state.roleId,
        state.eligibleStageId,
        state.firstUser.id,
      ],
    )
    const firstForeign = await readPortalDeal(request, state.secondSession, bundle.dealId)
    const wildcardForeign = await readPortalDeal(request, state.wildcardSession, bundle.dealId)
    const forged = await readPortalDeal(request, state.firstSession, forgedId)
    const crossOrganization = await readPortalDeal(
      request,
      state.firstSession,
      crossOrganizationDealId,
    )
    const noFeature = await readPortalDeal(request, state.noFeatureSession, bundle.dealId)
    expect(firstForeign.response.status()).toBe(404)
    expect(wildcardForeign.response.status()).toBe(404)
    expect(forged.response.status()).toBe(404)
    expect(crossOrganization.response.status()).toBe(404)
    expect(noFeature.response.status()).toBe(403)
    expect(firstForeign.body).toEqual(forged.body)
    await queryTestDatabase(
      'delete from finoo_intermediary_assignments where id = $1',
      [crossOrganizationAssignmentId],
    )
    await deleteAssignment(request, assignment)
  })

  test('TC-FINOO-INT-010 redirects intermediary Dashboard and renders the portal flow at desktop and narrow widths', async ({ page, request }) => {
    const bundle = await createDealBundle(request, { suffix: '010' })
    const assignment = await createAssignment(request, bundle.dealId)
    const baseUrl = process.env.BASE_URL ?? 'http://127.0.0.1:5001'
    const cookieDomain = new URL(baseUrl).hostname
    const usePortalSession = async (session: PortalSession) => {
      await page.context().clearCookies()
      await page.context().addCookies([
        {
          name: 'customer_auth_token',
          value: session.authToken,
          domain: cookieDomain,
          path: '/',
          httpOnly: true,
          secure: false,
        },
        {
          name: 'customer_session_token',
          value: session.sessionToken,
          domain: cookieDomain,
          path: '/',
          httpOnly: true,
          secure: false,
        },
      ])
    }

    await page.goto(`/${state.organizationSlug}/portal/login`)
    await page.getByLabel('Email').fill(state.firstUser.email)
    await page.getByLabel('Password', { exact: true }).fill(state.firstUser.password)
    await page.getByRole('button', { name: 'Log In', exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`/${state.organizationSlug}/portal/intermediary/deals$`))

    await page.goto(`/${state.organizationSlug}/portal`)
    await expect(page).toHaveURL(new RegExp(`/${state.organizationSlug}/portal/intermediary/deals$`))

    await page.goto(`/${state.organizationSlug}/portal/dashboard`)
    await expect(page).toHaveURL(new RegExp(`/${state.organizationSlug}/portal/intermediary/deals$`))
    await expect(page.getByRole('link', { name: 'Dashboard', exact: true })).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'Assigned deals', exact: true })).toBeVisible()

    await usePortalSession(state.wildcardSession)
    await page.goto(`/${state.organizationSlug}/portal/dashboard`)
    await expect(page).toHaveURL(new RegExp(`/${state.organizationSlug}/portal/dashboard$`))
    await expect(page.getByRole('link', { name: 'Dashboard', exact: true })).toBeVisible()

    await usePortalSession(state.firstSession)
    await page.goto(`/${state.organizationSlug}/portal/intermediary/deals`)
    await expect(page.getByText('Intermediary Company 010')).toBeVisible()
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByText('Intermediary Company 010').click()
    await expect(page.getByText('intermediary-person-010@test.local')).toBeVisible()
    await page.getByRole('button', { name: /start work/i }).click()
    await expect(page.getByText('In progress', { exact: true })).toBeVisible()
    await page.getByRole('textbox').fill('Headed intermediary note')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText('Headed intermediary note', { exact: true })).toBeVisible()
    const currentResponse = await apiRequest(
      request,
      'GET',
      `${ASSIGNMENTS}?dealId=${bundle.dealId}`,
      { token: state.token },
    )
    const current = (await readJsonSafe<{ assignment: Assignment }>(currentResponse))?.assignment
    await deleteAssignment(request, current ?? assignment)
  })
})
