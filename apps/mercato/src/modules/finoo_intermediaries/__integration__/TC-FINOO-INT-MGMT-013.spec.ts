import { expect, test } from '@playwright/test'
import {
  cleanupScenario,
  createCustomerUser,
  createScenario,
  inviteIntermediary,
  queryDatabase,
  type Scenario,
} from './helpers'

function rowForEmail(page: import('@playwright/test').Page, email: string) {
  return page.getByRole('row').filter({
    has: page.getByRole('cell', { name: email, exact: true }),
  })
}

async function openRowAction(page: import('@playwright/test').Page, email: string, action: string) {
  await rowForEmail(page, email).getByRole('button', { name: 'Open actions', exact: true }).click()
  await page.getByRole('menuitem', { name: action, exact: true }).click()
}

test('TC-FINOO-INT-MGMT-013 headed desktop and narrow lifecycle UI evidence', async ({ page, request }) => {
  test.setTimeout(60_000)
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
    await expect(page.getByText('Delivery failed', { exact: true }).first()).toBeVisible()
    await expect(page.getByText('Expired', { exact: true }).first()).toBeVisible()
    await expect(page.getByText('Active', { exact: true }).first()).toBeVisible()

    await page.getByRole('button', { name: 'Invite intermediary' }).click()
    await page.locator('[data-crud-field-id="email"] input').fill(scenario.recipient)
    await page.locator('[data-crud-field-id="firstName"] input').fill('Headed')
    await page.locator('[data-crud-field-id="lastName"] input').fill('Evidence')
    await page.locator('[data-crud-field-id="lastName"] input').press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter')
    await expect(page.getByRole('cell', { name: scenario.recipient, exact: true })).toBeVisible()
    await page.getByPlaceholder('Search by name or exact email').fill(scenario.recipient)
    await expect(page.getByRole('cell', { name: scenario.recipient, exact: true })).toBeVisible()
    await page.getByPlaceholder('Search by name or exact email').fill('')

    await openRowAction(page, scenario.recipient, 'Edit')
    await page.locator('[data-crud-field-id="firstName"] input').fill('Keyboard')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toBeHidden()
    await openRowAction(page, scenario.recipient, 'Edit')
    await page.locator('[data-crud-field-id="firstName"] input').fill('Keyboard')
    await page.locator('[data-crud-field-id="lastName"] input').press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter')
    await expect(page.getByText('Keyboard', { exact: true })).toBeVisible()

    await openRowAction(page, scenario.recipient, 'Cancel invitation')
    await expect(page.getByText('The current invitation link will stop working.')).toBeVisible()
    await page.getByRole('button', { name: /confirm|cancel invitation/i }).last().click()
    await expect(rowForEmail(page, scenario.recipient).getByRole('cell', { name: 'Inactive', exact: true })).toBeVisible()

    await openRowAction(page, `failed-${scenario.recipient}`, 'Retry')
    await expect(rowForEmail(page, `failed-${scenario.recipient}`).getByRole('cell', { name: 'Invited', exact: true })).toBeVisible()
    await openRowAction(page, `expired-${scenario.recipient}`, 'Resend')
    await expect(rowForEmail(page, `expired-${scenario.recipient}`).getByRole('cell', { name: 'Invited', exact: true })).toBeVisible()

    await openRowAction(page, activeUser.email, 'Deactivate')
    await expect(page.getByText(/entire Customer Portal account will be disabled/i)).toBeVisible()
    await page.getByRole('button', { name: /confirm|deactivate/i }).last().click()
    await expect(rowForEmail(page, activeUser.email).getByRole('cell', { name: 'Inactive', exact: true })).toBeVisible()
    await openRowAction(page, activeUser.email, 'Reactivate')
    await expect(page.getByText(/all preserved roles will resume/i)).toBeVisible()
    await page.getByRole('button', { name: /confirm|reactivate/i }).last().click()
    await expect(rowForEmail(page, activeUser.email).getByRole('cell', { name: 'Active', exact: true })).toBeVisible()

    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.getByRole('heading', { name: 'Intermediaries' })).toBeVisible()
    await expect(page.getByPlaceholder('Search by name or exact email')).toBeVisible()
  } finally {
    await cleanupScenario(request, scenario)
  }
})
