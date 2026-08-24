import { expect, test, type APIRequestContext } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createPersonFixture, readJsonSafe } from '@open-mercato/core/helpers/integration/crmFixtures'
import { createRoleFixture, createUserFixture, setRoleAclFeatures } from '@open-mercato/core/helpers/integration/authFixtures'
import { drainIntegrationQueue } from '@open-mercato/core/helpers/integration/queue'
import { OPTIMISTIC_LOCK_HEADER_NAME } from '@open-mercato/shared/lib/crud/optimistic-lock-headers'
import {
  cleanupScenario,
  createScenario,
  queryDatabase,
  scopedApiRequest,
  type Scenario,
} from '../../finoo_intermediaries/__integration__/helpers'

const SETTINGS = '/api/finoo_customer_retention/settings'
export const integrationMeta = {
  dependsOnModules: ['finoo_customer_retention', 'finoo_intermediaries', 'finoo_affiliates'],
}
const FEATURES = [
  'audit_logs.view', 'audit_logs.manage', 'audit_logs.undo_self',
  'finoo_intermediaries.view', 'finoo_intermediaries.manage',
  'customer_accounts.view', 'customer_accounts.manage', 'customer_accounts.roles.manage',
  'customer_accounts.invite', 'communication_channels.connect_user_channel',
  'customers.deals.view', 'customers.deals.manage', 'customers.pipelines.manage',
  'customers.companies.manage', 'customers.people.view', 'customers.people.manage',
  'customers.settings.manage', 'entities.definitions.manage',
]

type SettingBody = {
  setting: { inactivityWindowDays: number | null; reconciliationGeneration: number; updatedAt: string }
  updatedAt: string
  progressJobId?: string
}

async function ensureSettings(scenario: Scenario): Promise<void> {
  await queryDatabase(
    `insert into finoo_customer_retention_settings
      (id, tenant_id, organization_id, inactivity_window_days, reconciliation_generation, created_at, updated_at)
     values (gen_random_uuid(), $1, $2, null, 0, now(), now())
     on conflict (tenant_id, organization_id) do nothing`,
    [scenario.tenantId, scenario.organizationId],
  )
}

async function readSettings(request: APIRequestContext, scenario: Scenario): Promise<SettingBody> {
  const response = await scopedApiRequest(request, scenario, 'GET', SETTINGS)
  const body = (await readJsonSafe<SettingBody & { code?: string; error?: string }>(response))!
  expect(response.status(), JSON.stringify(body)).toBe(200)
  return body
}

async function updateSettings(
  request: APIRequestContext,
  scenario: Scenario,
  updatedAt: string,
  inactivityWindowDays: number | null,
  previewToken?: string,
) {
  return apiRequest(request, 'PUT', SETTINGS, {
    token: scenario.token,
    headers: {
      Cookie: `om_selected_org=${scenario.organizationId}`,
      [OPTIMISTIC_LOCK_HEADER_NAME]: updatedAt,
    },
    data: { inactivityWindowDays, ...(previewToken ? { previewToken } : {}) },
  })
}

async function previewSettings(
  request: APIRequestContext,
  scenario: Scenario,
  updatedAt: string | null,
  inactivityWindowDays: number,
) {
  return apiRequest(request, 'POST', `${SETTINGS}/preview`, {
    token: scenario.token,
    headers: {
      Cookie: `om_selected_org=${scenario.organizationId}`,
      ...(updatedAt ? { [OPTIMISTIC_LOCK_HEADER_NAME]: updatedAt } : {}),
    },
    data: { inactivityWindowDays },
  })
}

async function cleanup(request: APIRequestContext, scenario: Scenario | null): Promise<void> {
  if (scenario) {
    await queryDatabase('delete from action_logs where tenant_id=$1 and organization_id=$2', [scenario.tenantId, scenario.organizationId])
    await queryDatabase('delete from progress_jobs where tenant_id=$1 and organization_id=$2', [scenario.tenantId, scenario.organizationId])
    await queryDatabase('delete from custom_field_values where tenant_id=$1 and organization_id=$2', [scenario.tenantId, scenario.organizationId])
    await queryDatabase('delete from finoo_affiliates where tenant_id=$1 and organization_id=$2', [scenario.tenantId, scenario.organizationId])
    await queryDatabase('delete from finoo_customer_retention_states where tenant_id=$1 and organization_id=$2', [scenario.tenantId, scenario.organizationId])
    await queryDatabase('delete from finoo_customer_retention_settings where tenant_id=$1 and organization_id=$2', [scenario.tenantId, scenario.organizationId])
  }
  await cleanupScenario(request, scenario)
}

test('TC-FINOO-RET-001 settings lifecycle, preview races, locking, and ACL', async ({ request }) => {
  let scenario: Scenario | null = null
  try {
    scenario = await createScenario(request, 'TC-FINOO-RET-001', FEATURES)
    await ensureSettings(scenario)
    const initial = await readSettings(request, scenario)
    expect(initial.setting).toMatchObject({ inactivityWindowDays: null, reconciliationGeneration: 0 })

    const previewWithoutLock = await previewSettings(request, scenario, null, 30)
    expect(previewWithoutLock.status()).toBe(409)
    expect(await readJsonSafe<Record<string, unknown>>(previewWithoutLock)).toEqual({
      error: 'Expected settings version is required', code: 'optimistic_lock_required',
    })
    const updateWithoutLock = await apiRequest(request, 'PUT', SETTINGS, {
      token: scenario.token,
      headers: { Cookie: `om_selected_org=${scenario.organizationId}` },
      data: { inactivityWindowDays: null },
    })
    expect(updateWithoutLock.status()).toBe(409)
    expect(await readJsonSafe<Record<string, unknown>>(updateWithoutLock)).toEqual({
      error: 'Expected settings version is required', code: 'optimistic_lock_required',
    })

    const personId = await createPersonFixture(request, scenario.token, {
      firstName: 'Retention', lastName: 'Expired', displayName: 'TC-FINOO-RET-001 expired person',
    })
    await queryDatabase("update customer_entities set created_at=now()-interval '40 days' where id=$1", [personId])

    const previewResponse = await previewSettings(request, scenario, initial.updatedAt, 30)
    expect(previewResponse.status()).toBe(200)
    const preview = (await readJsonSafe<Record<string, unknown>>(previewResponse))!
    expect(preview).toMatchObject({ totalEligible: 1, newlyExpired: 1, alreadyExpired: 0 })
    expect(typeof preview.token).toBe('string')

    const enabledResponse = await updateSettings(request, scenario, String(preview.updatedAt), 30, String(preview.token))
    const enabled = (await readJsonSafe<SettingBody & { error?: string; code?: string }>(enabledResponse))!
    expect(enabledResponse.status(), JSON.stringify(enabled)).toBe(202)
    expect(enabled.setting).toMatchObject({ inactivityWindowDays: 30, reconciliationGeneration: 1 })
    expect(enabled.progressJobId).toBeTruthy()
    await drainIntegrationQueue('finoo-customer-retention-reconcile')
    await expect.poll(async () => (await queryDatabase<{ retention_status: string }>('select retention_status from finoo_customer_retention_states where customer_entity_id=$1', [personId]))[0]?.retention_status).toBe('expired')

    const settingLogs = await queryDatabase<{
      command_id: string
      command_payload: string
      snapshot_after: string
      undo_token: string | null
    }>(
      `select command_id, command_payload::text, snapshot_after::text, undo_token
       from action_logs
       where tenant_id=$1 and organization_id=$2
         and command_id in (
           'finoo_customer_retention.settings.preview',
           'finoo_customer_retention.settings.update'
         )
       order by created_at asc`,
      [scenario.tenantId, scenario.organizationId],
    )
    expect(settingLogs.map((entry) => entry.command_id)).toEqual([
      'finoo_customer_retention.settings.preview',
      'finoo_customer_retention.settings.update',
    ])
    expect(settingLogs[0]?.undo_token).toBeTruthy()
    expect(settingLogs[1]?.undo_token).toBeNull()
    expect(`${settingLogs[0]?.command_payload}${settingLogs[0]?.snapshot_after}`).not.toContain(String(preview.token))

    const increasedResponse = await updateSettings(request, scenario, enabled.setting.updatedAt, 60)
    expect(increasedResponse.status()).toBe(202)
    const increased = (await readJsonSafe<SettingBody>(increasedResponse))!
    await drainIntegrationQueue('finoo-customer-retention-reconcile')
    expect((await queryDatabase<{ retention_status: string }>('select retention_status from finoo_customer_retention_states where customer_entity_id=$1', [personId]))[0]?.retention_status).toBe('expired')

    const staleLock = await updateSettings(request, scenario, enabled.setting.updatedAt, null)
    expect(staleLock.status()).toBe(409)
    expect(await readJsonSafe<Record<string, unknown>>(staleLock)).toMatchObject({ code: 'optimistic_lock_conflict' })

    const stalePreview = await previewSettings(request, scenario, enabled.setting.updatedAt, 1)
    expect(stalePreview.status()).toBe(409)
    expect(await readJsonSafe<Record<string, unknown>>(stalePreview)).toMatchObject({ code: 'optimistic_lock_conflict' })

    const undoablePreviewResponse = await previewSettings(
      request,
      scenario,
      increased.setting.updatedAt,
      2,
    )
    expect(undoablePreviewResponse.status()).toBe(200)
    const previewUndoToken = (await queryDatabase<{ undo_token: string }>(
      `select undo_token
       from action_logs
       where tenant_id=$1 and organization_id=$2
         and command_id='finoo_customer_retention.settings.preview'
         and undo_token is not null
       order by created_at desc
       limit 1`,
      [scenario.tenantId, scenario.organizationId],
    ))[0]?.undo_token
    expect(previewUndoToken).toBeTruthy()
    const undoPreview = await apiRequest(
      request,
      'POST',
      '/api/audit_logs/audit-logs/actions/undo',
      { token: scenario.token, data: { undoToken: previewUndoToken } },
    )
    expect(undoPreview.ok()).toBe(true)
    expect((await queryDatabase<{ preview_token_hash: string | null }>(
      `select preview_token_hash
       from finoo_customer_retention_settings
       where tenant_id=$1 and organization_id=$2`,
      [scenario.tenantId, scenario.organizationId],
    ))[0]?.preview_token_hash).toBeNull()

    const afterUndo = await readSettings(request, scenario)
    const racePreviewResponse = await previewSettings(request, scenario, afterUndo.updatedAt, 1)
    const racePreview = (await readJsonSafe<Record<string, unknown>>(racePreviewResponse))!
    const racePersonId = await createPersonFixture(request, scenario.token, {
      firstName: 'Retention', lastName: 'Race', displayName: 'TC-FINOO-RET-001 count race',
    })
    await queryDatabase("update customer_entities set created_at=now()-interval '2 days' where id=$1", [racePersonId])
    const raced = await updateSettings(request, scenario, String(racePreview.updatedAt), 1, String(racePreview.token))
    const racedBody = await readJsonSafe<Record<string, unknown>>(raced)
    expect(raced.status(), JSON.stringify(racedBody)).toBe(409)
    expect(racedBody).toEqual({ error: 'Retention preview counts changed', code: 'preview_stale' })

    const restrictedRoleId = await createRoleFixture(request, scenario.superToken, { name: 'Retention restricted', tenantId: scenario.tenantId })
    await setRoleAclFeatures(request, scenario.superToken, { roleId: restrictedRoleId, features: ['customers.people.view'], organizations: [scenario.organizationId] })
    const restrictedEmail = `restricted-${Date.now()}@test.local`
    const restrictedPassword = 'Aa1!RetentionRestricted'
    const restrictedUserId = await createUserFixture(request, scenario.superToken, {
      email: restrictedEmail, password: restrictedPassword,
      organizationId: scenario.organizationId, roles: [restrictedRoleId], name: 'Restricted User',
    })
    expect(restrictedUserId).toBeTruthy()
    const restrictedToken = await getAuthToken(request, restrictedEmail, restrictedPassword)
    const forbidden = await apiRequest(request, 'GET', SETTINGS, {
      token: restrictedToken,
      headers: { Cookie: `om_selected_org=${scenario.organizationId}` },
    })
    expect(forbidden.status()).toBe(403)
    const unauthenticated = await request.get(SETTINGS)
    expect(unauthenticated.status()).toBe(401)

    expect((await readSettings(request, scenario)).setting.inactivityWindowDays).toBe(60)
  } finally {
    await cleanup(request, scenario)
  }
})
