import { expect, test } from '@playwright/test'
import {
  acceptInvitation,
  cleanupScenario,
  createScenario,
  inviteIntermediary,
  invitationToken,
  queryDatabase,
  waitForCapturedEmail,
  type Scenario,
} from './helpers'

test('TC-FINOO-INT-MGMT-003 duplicate pending invite rotates token and preserves one row', async ({ request }) => {
  let scenario: Scenario | null = null
  try {
    scenario = await createScenario(request, 'TC-FINOO-INT-MGMT-003')
    const first = await inviteIntermediary(request, scenario)
    expect(first.response.status()).toBe(201)
    const firstToken = invitationToken(await waitForCapturedEmail(scenario.recipient))
    const firstExpiry = first.body.item.invitationExpiresAt
    const second = await inviteIntermediary(request, scenario, { firstName: 'Grace', lastName: 'Hopper' })
    expect(second.response.status()).toBe(201)
    expect(second.body.item.id).toBe(first.body.item.id)
    expect(second.body.item).toMatchObject({ firstName: 'Grace', lastName: 'Hopper', status: 'invited' })
    expect(new Date(second.body.item.invitationExpiresAt!).getTime()).toBeGreaterThanOrEqual(new Date(firstExpiry!).getTime())
    const secondToken = invitationToken(await waitForCapturedEmail(scenario.recipient))
    expect(secondToken).not.toBe(firstToken)
    expect((await acceptInvitation(request, firstToken)).status()).toBe(400)
    expect((await queryDatabase<{ count: string }>('select count(*)::text as count from finoo_intermediaries where tenant_id=$1 and organization_id=$2', [scenario.tenantId, scenario.organizationId]))[0]?.count).toBe('1')
  } finally {
    await cleanupScenario(request, scenario)
  }
})
