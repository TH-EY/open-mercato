import { expect, test } from '@playwright/test'
import {
  cleanupScenario,
  createCustomerUser,
  createScenario,
  inviteIntermediary,
  queryDatabase,
  type Scenario,
} from './helpers'

async function openRowAction(page: import('@playwright/test').Page, email: string, action: string) {
  const row = page.getByRole('row').filter({ hasText: email })
  await row.getByRole('button', { name: /actions/i }).click()
  await page.getByRole('menuitem', { name: action, exact: true }).click()
}

test('TC-FINOO-INT-MGMT-013 headed desktop and narrow lifecycle UI evidence', async ({ page, request }) => {
  let scenario: Scenario | null = null
  try {
    scenario = await createScenario(request, 'TC-FINOO-INT-MGMT-013')
    const activeUser = await createCustomerUser(request, scenario, { email: `active-${scenario.recipient}` })
    await inviteIntermediary(request, scenario, { email: activeUser.email, firstName: 'Active', lastName: 'Person' })
    const failed = await inviteIntermediary(request, scenario, { email: `failed-${scenario.recipient}`, firstName: 'Failed' })
    await queryDatabase(
      `update finoo_intermediaries set lifecycle_state='delivery_failed',last_email_status='failed',
       last_email_error_code='email_delivery_failed',updated_at=now() where id=$1`,
      [failed.body.item.id],
    )
    const expired = await inviteIntermediary(request, scenario, { email: `expired-${scenario.recipient}`, firstName: 'Expired' })
    await queryDatabase('update finoo_intermediaries set invitation_expires_at=now()-interval \'1 minute\' where id=$1', [expired.body.item.id])

    const form = new URLSearchParams({ email: scenario.staffEmail, password: scenario.staffPassword })
    expect((await page.request.post('/api/auth/login', {
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, data: form.toString(),
    })).ok()).toBeTruthy()
    const baseUrl = process.env.BASE_URL
    expect(baseUrl, 'managed runner must provide BASE_URL').toBeTruthy()
    await page.context().addCookies([{ name: 'om_selected_org', value: scenario.organizationId, url: baseUrl! }])
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/backend/finoo-intermediaries/intermediaries')
    await expect(page.getByRole('heading', { name: 'Intermediaries' })).toBeVisible()
    await expect(page.getByText('Delivery failed', { exact: true })).toBeVisible()
    await expect(page.getByText('Expired', { exact: true })).toBeVisible()
    await expect(page.getByText('Active', { exact: true })).toBeVisible()

    await page.getByRole('button', { name: 'Invite intermediary' }).click()
    await page.getByLabel('Email').fill(scenario.recipient)
    await page.getByLabel('First name').fill('Headed')
    await page.getByLabel('Last name').fill('Evidence')
    await page.getByLabel('Last name').press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter')
    await expect(page.getByRole('cell', { name: scenario.recipient })).toBeVisible()
    await page.getByPlaceholder('Search by name or exact email').fill(scenario.recipient)
    await expect(page.getByRole('cell', { name: scenario.recipient })).toBeVisible()
    await page.getByPlaceholder('Search by name or exact email').fill('')

    await openRowAction(page, scenario.recipient, 'Edit')
    await page.getByLabel('First name').fill('Keyboard')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toBeHidden()
    await openRowAction(page, scenario.recipient, 'Edit')
    await page.getByLabel('First name').fill('Keyboard')
    await page.getByLabel('Last name').press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter')
    await expect(page.getByText('Keyboard', { exact: true })).toBeVisible()

    await openRowAction(page, scenario.recipient, 'Cancel invitation')
    await expect(page.getByText('The current invitation link will stop working.')).toBeVisible()
    await page.getByRole('button', { name: /confirm|cancel invitation/i }).last().click()
    await expect(page.getByText('Inactive', { exact: true })).toBeVisible()

    await openRowAction(page, `failed-${scenario.recipient}`, 'Retry')
    await expect(page.getByText('Invited', { exact: true })).toBeVisible()
    await openRowAction(page, `expired-${scenario.recipient}`, 'Resend')
    await expect(page.getByText('Invited', { exact: true })).toBeVisible()

    await openRowAction(page, activeUser.email, 'Deactivate')
    await expect(page.getByText(/entire Customer Portal account will be disabled/i)).toBeVisible()
    await page.getByRole('button', { name: /confirm|deactivate/i }).last().click()
    await openRowAction(page, activeUser.email, 'Reactivate')
    await expect(page.getByText(/all preserved roles will resume/i)).toBeVisible()
    await page.getByRole('button', { name: /confirm|reactivate/i }).last().click()

    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.getByRole('heading', { name: 'Intermediaries' })).toBeVisible()
    await expect(page.getByPlaceholder('Search by name or exact email')).toBeVisible()
  } finally {
    await cleanupScenario(request, scenario)
  }
})
