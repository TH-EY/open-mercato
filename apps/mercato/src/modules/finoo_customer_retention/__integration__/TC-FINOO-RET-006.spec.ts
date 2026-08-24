import path from 'node:path'
import { expect, test, type APIRequestContext } from '@playwright/test'
import { apiRequest } from '@open-mercato/core/helpers/integration/api'
import { createPersonFixture, readJsonSafe } from '@open-mercato/core/helpers/integration/crmFixtures'
import { drainIntegrationQueue } from '@open-mercato/core/helpers/integration/queue'
import { createQueue } from '@open-mercato/queue'
import { OPTIMISTIC_LOCK_HEADER_NAME } from '@open-mercato/shared/lib/crud/optimistic-lock-headers'
import {
  cleanupScenario, createScenario, queryDatabase, scopedApiRequest, type Scenario,
} from '../../finoo_intermediaries/__integration__/helpers'

export const integrationMeta = {
  dependsOnModules: ['finoo_customer_retention', 'finoo_intermediaries', 'finoo_affiliates'],
}
const FEATURES = [
  'finoo_intermediaries.view', 'finoo_intermediaries.manage', 'customer_accounts.view',
  'customer_accounts.manage', 'customer_accounts.roles.manage', 'customer_accounts.invite',
  'communication_channels.connect_user_channel', 'customers.deals.view', 'customers.deals.manage',
  'customers.pipelines.manage', 'customers.companies.manage', 'customers.people.view',
  'customers.people.manage', 'customers.settings.manage', 'customers.activities.view',
  'customers.activities.manage', 'entities.definitions.manage',
]

type SettingsBody = {
  setting: { inactivityWindowDays: number | null; reconciliationGeneration: number; updatedAt: string }
  progressJobId?: string
}

async function updateSettings(
  request: APIRequestContext,
  scenario: Scenario,
  updatedAt: string,
  inactivityWindowDays: number | null,
  previewToken?: string,
) {
  return apiRequest(request, 'PUT', '/api/finoo_customer_retention/settings', {
    token: scenario.token,
    headers: {
      Cookie: `om_selected_org=${scenario.organizationId}`,
      [OPTIMISTIC_LOCK_HEADER_NAME]: updatedAt,
    },
    data: { inactivityWindowDays, ...(previewToken ? { previewToken } : {}) },
  })
}

async function cleanup(request: APIRequestContext, scenario: Scenario | null): Promise<void> {
  if (scenario) {
    await queryDatabase('delete from progress_jobs where tenant_id=$1 and organization_id=$2', [scenario.tenantId, scenario.organizationId])
    await queryDatabase('delete from custom_field_values where tenant_id=$1 and organization_id=$2', [scenario.tenantId, scenario.organizationId])
    await queryDatabase('delete from finoo_affiliates where tenant_id=$1 and organization_id=$2', [scenario.tenantId, scenario.organizationId])
    await queryDatabase('delete from finoo_customer_retention_states where tenant_id=$1 and organization_id=$2', [scenario.tenantId, scenario.organizationId])
    await queryDatabase('delete from finoo_customer_retention_settings where tenant_id=$1 and organization_id=$2', [scenario.tenantId, scenario.organizationId])
  }
  await cleanupScenario(request, scenario)
}

test('TC-FINOO-RET-006 disabling invalidates old generations and keeps expired people sticky', async ({ request }) => {
  let scenario: Scenario | null = null
  try {
    scenario = await createScenario(request, 'TC-FINOO-RET-006', FEATURES)
    await queryDatabase(
      `insert into finoo_customer_retention_settings
       (id,tenant_id,organization_id,inactivity_window_days,reconciliation_generation,created_at,updated_at)
       values(gen_random_uuid(),$1,$2,null,0,now(),now())
       on conflict (tenant_id,organization_id) do update
       set inactivity_window_days=null,reconciliation_generation=0,updated_at=now()`, [scenario.tenantId, scenario.organizationId],
    )
    const personId = await createPersonFixture(request, scenario.token, {
      firstName: 'Rollback', lastName: 'Sticky', displayName: 'TC-FINOO-RET-006 sticky expired',
    })
    await queryDatabase("update customer_entities set created_at=now()-interval '2 days' where id=$1", [personId])

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
    const preview = (await readJsonSafe<Record<string, unknown>>(previewResponse))!
    const enabledResponse = await updateSettings(request, scenario, String(preview.updatedAt), 1, String(preview.token))
    expect(enabledResponse.status()).toBe(202)
    const enabled = (await readJsonSafe<SettingsBody>(enabledResponse))!
    const oldGeneration = enabled.setting.reconciliationGeneration
    await drainIntegrationQueue('finoo-customer-retention-reconcile')
    await expect.poll(async () => (await queryDatabase<{ retention_status: string }>('select retention_status from finoo_customer_retention_states where customer_entity_id=$1', [personId]))[0]?.retention_status).toBe('expired')

    const increasedResponse = await updateSettings(request, scenario, enabled.setting.updatedAt, 60)
    expect(increasedResponse.status()).toBe(202)
    const increased = (await readJsonSafe<SettingsBody>(increasedResponse))!
    expect(increased.setting.reconciliationGeneration).toBe(oldGeneration + 1)
    await drainIntegrationQueue('finoo-customer-retention-reconcile')
    expect((await queryDatabase<{ retention_status: string }>(
      'select retention_status from finoo_customer_retention_states where customer_entity_id=$1', [personId],
    ))[0]?.retention_status).toBe('expired')

    const disabledResponse = await updateSettings(request, scenario, increased.setting.updatedAt, null)
    expect(disabledResponse.status()).toBe(202)
    const disabled = (await readJsonSafe<SettingsBody>(disabledResponse))!
    expect(disabled.setting).toMatchObject({
      inactivityWindowDays: null,
      reconciliationGeneration: increased.setting.reconciliationGeneration + 1,
    })

    const appRoot = path.resolve(process.env.OM_TEST_APP_ROOT?.trim() || path.resolve(process.cwd(), 'apps/mercato'))
    const queue = createQueue<{
      tenantId: string; organizationId: string; reconciliationGeneration?: number; afterCustomerEntityId?: string
    }>('finoo-customer-retention-reconcile', 'local', {
      baseDir: path.resolve(appRoot, '.mercato/queue'),
      concurrency: 1,
    })
    await queue.enqueue({
      tenantId: scenario.tenantId,
      organizationId: scenario.organizationId,
      reconciliationGeneration: oldGeneration,
      afterCustomerEntityId: '00000000-0000-0000-0000-000000000000',
    })
    await drainIntegrationQueue('finoo-customer-retention-reconcile')
    expect((await queryDatabase<{ retention_status: string }>('select retention_status from finoo_customer_retention_states where customer_entity_id=$1', [personId]))[0]?.retention_status).toBe('expired')

    await queue.enqueue({ tenantId: scenario.tenantId, organizationId: scenario.organizationId })
    await drainIntegrationQueue('finoo-customer-retention-reconcile')
    const finalState = (await queryDatabase<{ retention_status: string; expired_at: string | null }>(
      'select retention_status,expired_at from finoo_customer_retention_states where customer_entity_id=$1', [personId],
    ))[0]!
    expect(finalState.retention_status).toBe('expired')
    expect(finalState.expired_at).toBeTruthy()

    const activityResponse = await apiRequest(request, 'POST', '/api/customers/comments', {
      token: scenario.token,
      data: { entityId: personId, body: 'TC-FINOO-RET-006 qualifying reactivation activity' },
    })
    expect(activityResponse.status()).toBe(201)
    await drainIntegrationQueue('events')
    await drainIntegrationQueue('finoo-customer-retention-reconcile')
    await expect.poll(async () => (await queryDatabase<{ retention_status: string }>(
      'select retention_status from finoo_customer_retention_states where customer_entity_id=$1', [personId],
    ))[0]?.retention_status).toBe('active')
  } finally {
    await cleanup(request, scenario)
  }
})
