import { expect, test, type APIRequestContext } from '@playwright/test'
import { createPersonFixture } from '@open-mercato/core/helpers/integration/crmFixtures'
import { drainIntegrationQueue } from '@open-mercato/core/helpers/integration/queue'
import {
  cleanupScenario, createScenario, queryDatabase, type Scenario,
} from '../../finoo_intermediaries/__integration__/helpers'

export const integrationMeta = {
  dependsOnModules: ['finoo_customer_retention', 'finoo_intermediaries', 'finoo_affiliates'],
}
const FEATURES = [
  'finoo_intermediaries.view', 'finoo_intermediaries.manage', 'customer_accounts.view',
  'customer_accounts.manage', 'customer_accounts.roles.manage', 'customer_accounts.invite',
  'communication_channels.connect_user_channel', 'customers.deals.view', 'customers.deals.manage',
  'customers.pipelines.manage', 'customers.companies.manage', 'customers.people.view',
  'customers.people.manage', 'customers.settings.manage', 'entities.definitions.manage',
]

async function loginScenario(page: import('@playwright/test').Page, scenario: Scenario): Promise<void> {
  const form = new URLSearchParams({ email: scenario.staffEmail, password: scenario.staffPassword })
  const response = await page.request.post('/api/auth/login', {
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, data: form.toString(),
  })
  expect(response.ok()).toBe(true)
  const baseUrl = process.env.BASE_URL
  expect(baseUrl, 'managed Playwright runner must provide BASE_URL').toBeTruthy()
  await page.context().addCookies([{ name: 'om_selected_org', value: scenario.organizationId, url: baseUrl! }])
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

test('TC-FINOO-RET-005 settings hydration, preview keyboard flow, progress, and people columns', async ({ page, request }) => {
  let scenario: Scenario | null = null
  try {
    scenario = await createScenario(request, 'TC-FINOO-RET-005', FEATURES)
    await queryDatabase(
      `insert into finoo_customer_retention_settings
       (id,tenant_id,organization_id,inactivity_window_days,reconciliation_generation,created_at,updated_at)
       values(gen_random_uuid(),$1,$2,null,0,now(),now())
       on conflict (tenant_id,organization_id) do update
       set inactivity_window_days=null,reconciliation_generation=0,updated_at=now()`, [scenario.tenantId, scenario.organizationId],
    )
    const personId = await createPersonFixture(request, scenario.token, {
      firstName: 'Visible', lastName: 'Expired', displayName: 'TC-FINOO-RET-005 visible expired',
    })
    await queryDatabase("update customer_entities set created_at=now()-interval '40 days' where id=$1", [personId])

    await loginScenario(page, scenario)
    await page.goto('/backend/config/customers/retention', { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: 'Customer data retention', level: 1 })).toBeVisible()
    const enabledSwitch = page.getByRole('switch', { name: 'Enable retention expiry' })
    await expect(enabledSwitch).not.toBeChecked()
    const daysInput = page.getByLabel('Inactivity period in days')
    await expect(daysInput).toBeDisabled()

    await enabledSwitch.click()
    await daysInput.fill('30')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    const dialog = page.getByRole('alertdialog', { name: 'Confirm retention period change' })
    await expect(dialog).toContainText('Eligible people: 1. Newly expired: 1. Already expired: 0.')
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()

    await daysInput.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter')
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Apply retention period' }).click()
    await expect(page.getByText('Reconciliation has started. Progress is visible in the top bar.')).toBeVisible()
    await expect(enabledSwitch).toBeChecked()
    await expect(daysInput).toHaveValue('30')

    await drainIntegrationQueue('finoo-customer-retention-reconcile')
    await expect.poll(async () => (await queryDatabase<{ retention_status: string }>(
      'select retention_status from finoo_customer_retention_states where customer_entity_id=$1', [personId],
    ))[0]?.retention_status).toBe('expired')
    await drainIntegrationQueue('events')
    await page.goto('/backend/customers/people', { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('button', { name: 'Retention status', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Retention expiry', exact: true })).toBeVisible()
    const personRow = page.getByRole('row').filter({ hasText: 'TC-FINOO-RET-005 visible expired' })
    await expect(personRow).toContainText('expired')

    const localeResponse = await page.request.post('/api/auth/locale', {
      headers: { 'content-type': 'application/json' }, data: { locale: 'pl' },
    })
    expect(localeResponse.ok()).toBe(true)
    await page.goto('/backend/config/customers/retention', { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: 'Retencja danych klientów', level: 1 })).toBeVisible()
    await expect(page.getByLabel('Okres braku aktywności w dniach')).toHaveValue('30')
  } finally {
    await page.request.post('/api/auth/locale', {
      headers: { 'content-type': 'application/json' }, data: { locale: 'en' },
    }).catch(() => {})
    await cleanup(request, scenario)
  }
})
