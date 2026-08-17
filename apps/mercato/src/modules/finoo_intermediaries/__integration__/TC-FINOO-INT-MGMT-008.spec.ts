import { expect, test } from '@playwright/test'
import { portalLogin } from '@open-mercato/core/helpers/integration/customerAccountsFixtures'
import {
  cleanupScenario,
  createCustomerUser,
  createScenario,
  inviteIntermediary,
  queryDatabase,
  runLifecycleAction,
  setCustomerUserActive,
  type Scenario,
} from './helpers'

test('TC-FINOO-INT-MGMT-008 inactive account requires explicit whole-account reactivation', async ({ request }) => {
  let scenario: Scenario | null = null
  try {
    scenario = await createScenario(request, 'TC-FINOO-INT-MGMT-008')
    const user = await createCustomerUser(request, scenario)
    await setCustomerUserActive(user.id, false)
    const linked = await inviteIntermediary(request, scenario)
    expect(linked.response.status()).toBe(200)
    expect(linked.body).toMatchObject({ requiresReactivation: true, item: { status: 'inactive', hasLinkedAccount: true } })
    expect((await queryDatabase<{ count: string }>('select count(*)::text count from customer_user_roles where user_id=$1 and role_id=$2 and deleted_at is null', [user.id, scenario.intermediaryRoleId]))[0]?.count).toBe('0')
    const reactivated = await runLifecycleAction(request, scenario, linked.body.item, 'reactivate')
    expect(reactivated.response.status()).toBe(200)
    expect(reactivated.body.item.status).toBe('active')
    const session = await portalLogin(request, { email: user.email, password: user.password, tenantId: scenario.tenantId })
    expect(session.sessionToken).toBeTruthy()
  } finally {
    await cleanupScenario(request, scenario)
  }
})
