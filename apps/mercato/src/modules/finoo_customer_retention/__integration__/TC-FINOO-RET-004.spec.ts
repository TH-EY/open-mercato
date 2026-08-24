import { expect, test, type APIRequestContext } from '@playwright/test'
import { apiRequest } from '@open-mercato/core/helpers/integration/api'
import { createPersonFixture, readJsonSafe } from '@open-mercato/core/helpers/integration/crmFixtures'
import { drainIntegrationQueue } from '@open-mercato/core/helpers/integration/queue'
import { OPTIMISTIC_LOCK_HEADER_NAME } from '@open-mercato/shared/lib/crud/optimistic-lock-headers'
import {
  cleanupScenario, createScenario, queryDatabase, scopedApiRequest, type Scenario,
} from '../../finoo_intermediaries/__integration__/helpers'

export const integrationMeta = {
  dependsOnModules: ['finoo_customer_retention', 'finoo_intermediaries', 'finoo_affiliates', 'perspectives'],
}
const FEATURES = [
  'finoo_intermediaries.view', 'finoo_intermediaries.manage', 'customer_accounts.view',
  'customer_accounts.manage', 'customer_accounts.roles.manage', 'customer_accounts.invite',
  'communication_channels.connect_user_channel', 'customers.deals.view', 'customers.deals.manage',
  'customers.pipelines.manage', 'customers.companies.manage', 'customers.people.view',
  'customers.people.manage', 'customers.settings.manage', 'entities.definitions.manage',
  'perspectives.use',
]
const EXPIRED_FILTER_QUERY = new URLSearchParams({
  'filter[v]': '2',
  'filter[root][combinator]': 'and',
  'filter[root][children][0][type]': 'rule',
  'filter[root][children][0][field]': 'cf_finoo_retention_status',
  'filter[root][children][0][op]': 'is',
  'filter[root][children][0][value]': 'expired',
}).toString()

test.setTimeout(120_000)

async function cleanup(request: APIRequestContext, scenario: Scenario | null): Promise<void> {
  if (scenario) {
    await queryDatabase('delete from progress_jobs where tenant_id=$1 and organization_id=$2', [scenario.tenantId, scenario.organizationId])
    await queryDatabase('delete from custom_field_values where tenant_id=$1 and organization_id=$2', [scenario.tenantId, scenario.organizationId])
    await queryDatabase('delete from finoo_affiliates where tenant_id=$1 and organization_id=$2', [scenario.tenantId, scenario.organizationId])
    await queryDatabase('delete from finoo_customer_retention_states where tenant_id=$1 and organization_id=$2', [scenario.tenantId, scenario.organizationId])
    await queryDatabase('delete from finoo_customer_retention_settings where tenant_id=$1 and organization_id=$2', [scenario.tenantId, scenario.organizationId])
    await queryDatabase('delete from role_perspectives where tenant_id=$1 and organization_id=$2', [scenario.tenantId, scenario.organizationId])
    await queryDatabase('delete from perspectives where tenant_id=$1 and organization_id=$2', [scenario.tenantId, scenario.organizationId])
  }
  await cleanupScenario(request, scenario)
}

test('TC-FINOO-RET-004 more than 200 people reconcile across pages and filter through standard custom fields', async ({ request }) => {
  let scenario: Scenario | null = null
  try {
    scenario = await createScenario(request, 'TC-FINOO-RET-004', FEATURES)
    await queryDatabase(
      `insert into finoo_customer_retention_settings
       (id,tenant_id,organization_id,inactivity_window_days,reconciliation_generation,created_at,updated_at)
       values(gen_random_uuid(),$1,$2,null,0,now(),now())
       on conflict (tenant_id,organization_id) do update
       set inactivity_window_days=null,reconciliation_generation=0,updated_at=now()`, [scenario.tenantId, scenario.organizationId],
    )
    const templatePersonId = await createPersonFixture(request, scenario.token, {
      firstName: 'Retention', lastName: 'Paged', displayName: 'TC-FINOO-RET-004 Paged fixture',
    })
    await queryDatabase(
      `with template_entity as (
         select * from customer_entities where id=$1
       ), template_profile as (
         select * from customer_people where entity_id=$1
       ), inserted_entities as (
         insert into customer_entities
           (id,organization_id,tenant_id,kind,display_name,description,owner_user_id,
            primary_email,primary_phone,status,lifecycle_stage,source,temperature,renewal_quarter,
            next_interaction_at,next_interaction_name,next_interaction_ref_id,next_interaction_icon,
            next_interaction_color,is_active,created_at,updated_at,deleted_at)
         select gen_random_uuid(),organization_id,tenant_id,kind,display_name,description,owner_user_id,
            primary_email,primary_phone,status,lifecycle_stage,source,temperature,renewal_quarter,
            next_interaction_at,next_interaction_name,next_interaction_ref_id,next_interaction_icon,
            next_interaction_color,is_active,now()-interval '2 days',now(),null
         from template_entity cross join generate_series(1,204)
         returning id,organization_id,tenant_id
       )
       insert into customer_people
         (id,organization_id,tenant_id,first_name,last_name,preferred_name,job_title,department,
          seniority,timezone,linked_in_url,twitter_url,created_at,updated_at,entity_id,company_entity_id)
       select gen_random_uuid(),inserted.organization_id,inserted.tenant_id,profile.first_name,
          profile.last_name,profile.preferred_name,profile.job_title,profile.department,
          profile.seniority,profile.timezone,profile.linked_in_url,profile.twitter_url,
          now()-interval '2 days',now(),inserted.id,null
       from inserted_entities inserted cross join template_profile profile`,
      [templatePersonId],
    )
    const personIds = (await queryDatabase<{ id: string }>(
      "select id from customer_entities where tenant_id=$1 and organization_id=$2 and kind='person' and deleted_at is null",
      [scenario.tenantId, scenario.organizationId],
    )).map((row) => row.id)
    expect(personIds).toHaveLength(205)
    await queryDatabase("update customer_entities set created_at=now()-interval '2 days' where id=any($1::uuid[])", [personIds])
    await queryDatabase(
      'delete from finoo_customer_retention_states where tenant_id=$1 and organization_id=$2',
      [scenario.tenantId, scenario.organizationId],
    )

    const settingsResponse = await scopedApiRequest(request, scenario, 'GET', '/api/finoo_customer_retention/settings')
    const settings = (await readJsonSafe<Record<string, unknown>>(settingsResponse))!
    const previewResponse = await apiRequest(request, 'POST', '/api/finoo_customer_retention/settings/preview', {
      token: scenario.token,
      headers: {
        Cookie: `om_selected_org=${scenario.organizationId}`,
        [OPTIMISTIC_LOCK_HEADER_NAME]: String(settings.updatedAt),
      },
      data: { inactivityWindowDays: 1 },
    })
    expect(previewResponse.status()).toBe(200)
    const preview = (await readJsonSafe<Record<string, unknown>>(previewResponse))!
    expect(preview).toMatchObject({ totalEligible: 205, newlyExpired: 205, alreadyExpired: 0 })
    const enabledResponse = await apiRequest(request, 'PUT', '/api/finoo_customer_retention/settings', {
      token: scenario.token,
      headers: {
        Cookie: `om_selected_org=${scenario.organizationId}`,
        [OPTIMISTIC_LOCK_HEADER_NAME]: String(preview.updatedAt),
      },
      data: { inactivityWindowDays: 1, previewToken: preview.token },
    })
    expect(enabledResponse.status()).toBe(202)
    await drainIntegrationQueue('finoo-customer-retention-reconcile', { jobLimit: 20 })
    await expect.poll(async () => {
      await drainIntegrationQueue('finoo-customer-retention-reconcile', { jobLimit: 20 })
      return (await queryDatabase<{ count: string }>(
        "select count(*)::text count from finoo_customer_retention_states where tenant_id=$1 and organization_id=$2 and retention_status='expired'",
        [scenario!.tenantId, scenario!.organizationId],
      ))[0]?.count
    }, { timeout: 60_000 }).toBe('205')
    await drainIntegrationQueue('events', { jobLimit: 500 })

    const pageTwoResponse = await scopedApiRequest(
      request, scenario, 'GET',
      `/api/customers/people?page=2&pageSize=100&sortField=cf_finoo_retention_expires_at&sortDir=asc&${EXPIRED_FILTER_QUERY}`,
    )
    expect(pageTwoResponse.status()).toBe(200)
    const pageTwo = (await readJsonSafe<Record<string, unknown>>(pageTwoResponse))!
    const items = Array.isArray(pageTwo.items) ? pageTwo.items as Array<Record<string, unknown>> : []
    expect(pageTwo.total).toBe(205)
    expect(items).toHaveLength(100)

    const searchedResponse = await scopedApiRequest(
      request, scenario, 'GET',
      `/api/customers/people?page=1&pageSize=100&search=${encodeURIComponent('TC-FINOO-RET-004 no match')}&${EXPIRED_FILTER_QUERY}`,
    )
    const searched = (await readJsonSafe<Record<string, unknown>>(searchedResponse))!
    expect(searched.total).toBe(0)
    expect(searched.items).toEqual([])

    const activePersonId = await createPersonFixture(request, scenario.token, {
      firstName: 'Retention', lastName: 'Active', displayName: 'TC-FINOO-RET-004 active control',
    })
    await drainIntegrationQueue('finoo-customer-retention-reconcile')
    expect((await queryDatabase<{ retention_status: string }>(
      'select retention_status from finoo_customer_retention_states where customer_entity_id=$1',
      [activePersonId],
    ))[0]?.retention_status).toBe('active')

    const filteredResponse = await scopedApiRequest(
      request, scenario, 'GET',
      `/api/customers/people?page=1&pageSize=100&${EXPIRED_FILTER_QUERY}`,
    )
    expect(filteredResponse.status()).toBe(200)
    const filtered = (await readJsonSafe<Record<string, unknown>>(filteredResponse))!
    expect(filtered.total).toBe(205)

    const exportResponse = await scopedApiRequest(
      request, scenario, 'GET',
      `/api/customers/people?format=json&exportScope=view&${EXPIRED_FILTER_QUERY}`,
    )
    expect(exportResponse.status()).toBe(200)
    expect(exportResponse.headers()['content-type']).toContain('application/json')
    const exportedRows = (await readJsonSafe<unknown[]>(exportResponse)) ?? []
    expect(exportedRows).toHaveLength(205)
    expect(exportedRows.some((row) => JSON.stringify(row).includes('TC-FINOO-RET-004 active control'))).toBe(false)

    const savedFilter = {
      v: 2,
      root: {
        id: 'retention-root',
        type: 'group',
        combinator: 'and',
        children: [{
          id: 'retention-expired',
          type: 'rule',
          field: 'cf_finoo_retention_status',
          operator: 'is',
          value: 'expired',
        }],
      },
    }
    const perspectiveResponse = await apiRequest(request, 'POST', '/api/perspectives/customers.people.list', {
      token: scenario.token,
      headers: { Cookie: `om_selected_org=${scenario.organizationId}` },
      data: {
        name: 'TC-FINOO-RET-004 expired customers',
        settings: { filters: savedFilter, sorting: [{ id: 'cf_finoo_retention_expires_at', desc: false }] },
        isDefault: false,
      },
    })
    expect(perspectiveResponse.status()).toBe(200)
    const perspective = await readJsonSafe<{ perspective?: { id?: string } }>(perspectiveResponse)
    expect(perspective?.perspective?.id).toBeTruthy()
    const perspectivesResponse = await scopedApiRequest(
      request, scenario, 'GET', '/api/perspectives/customers.people.list',
    )
    expect(perspectivesResponse.status()).toBe(200)
    const perspectives = await readJsonSafe<{
      perspectives?: Array<{ id?: string; settings?: { filters?: unknown; sorting?: unknown } }>
    }>(perspectivesResponse)
    expect(perspectives?.perspectives?.find((item) => item.id === perspective?.perspective?.id)?.settings)
      .toMatchObject({
        filters: savedFilter,
        sorting: [{ id: 'cf_finoo_retention_expires_at', desc: false }],
      })
  } finally {
    await cleanup(request, scenario)
  }
})
