import { expect, test } from '@playwright/test'
import { drainIntegrationQueue } from '@open-mercato/core/helpers/integration/queue'
import {
  acceptInvitation,
  cleanupScenario,
  createScenario,
  inviteIntermediary,
  invitationToken,
  listDirectory,
  queryDatabase,
  waitForCapturedEmail,
  type Scenario,
} from './helpers'

test('TC-FINOO-INT-MGMT-002 encrypted invite, capture, and activation', async ({ request }) => {
  let scenario: Scenario | null = null
  try {
    scenario = await createScenario(request, 'TC-FINOO-INT-MGMT-002')
    const invited = await inviteIntermediary(request, scenario)
    expect(invited.response.status()).toBe(201)
    expect(invited.body.item.status).toBe('invited')
    const stored = await queryDatabase<{ first_name: string; last_name: string; email: string; token: string }>(
      `select fi.first_name, fi.last_name, fi.email, cui.token
       from finoo_intermediaries fi join customer_user_invitations cui on cui.id = fi.invitation_id
       where fi.id = $1`,
      [invited.body.item.id],
    )
    expect(stored[0]?.first_name).not.toBe('Ada')
    expect(stored[0]?.last_name).not.toBe('Lovelace')
    expect(stored[0]?.email).not.toBe(scenario.recipient)
    expect(JSON.stringify(invited.body)).not.toContain(stored[0]?.token)

    const token = invitationToken(await waitForCapturedEmail(scenario.recipient))
    const accepted = await acceptInvitation(request, token)
    expect(accepted.status()).toBe(201)
    await drainIntegrationQueue('events')
    const active = await listDirectory(request, scenario, `?search=${encodeURIComponent(scenario.recipient)}`)
    expect(active.items[0]).toMatchObject({ status: 'active', hasLinkedAccount: true })
  } finally {
    await cleanupScenario(request, scenario)
  }
})
