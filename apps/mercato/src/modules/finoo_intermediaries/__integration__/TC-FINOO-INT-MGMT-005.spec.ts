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
  runLifecycleAction,
  waitForCapturedEmail,
  type Scenario,
} from './helpers'

test('TC-FINOO-INT-MGMT-005 effective expiry, resend, cancellation, and terminal race', async ({ request }) => {
  let scenario: Scenario | null = null
  try {
    scenario = await createScenario(request, 'TC-FINOO-INT-MGMT-005')
    const invited = await inviteIntermediary(request, scenario)
    const oldToken = invitationToken(await waitForCapturedEmail(scenario.recipient))
    await queryDatabase('update finoo_intermediaries set invitation_expires_at=now()-interval \'1 minute\' where id=$1', [invited.body.item.id])
    const expired = (await listDirectory(request, scenario)).items[0]
    expect(expired.status).toBe('expired')
    const resent = await runLifecycleAction(request, scenario, expired, 'resend')
    expect(resent.body.item.status).toBe('invited')
    const newToken = invitationToken(await waitForCapturedEmail(scenario.recipient))
    expect((await acceptInvitation(request, oldToken)).status()).toBe(400)
    const [cancelled, accepted] = await Promise.all([
      runLifecycleAction(request, scenario, resent.body.item, 'cancel-invitation'),
      acceptInvitation(request, newToken),
    ])
    expect([cancelled.response.status(), accepted.status()].filter((status) => status < 300)).toHaveLength(1)
    if (accepted.status() < 300) await drainIntegrationQueue('events')
    const terminal = (await listDirectory(request, scenario)).items[0]
    expect(['active', 'inactive']).toContain(terminal.status)
    expect((await acceptInvitation(request, newToken)).status()).toBe(400)
    expect((await acceptInvitation(request, oldToken)).status()).toBe(400)
  } finally {
    await cleanupScenario(request, scenario)
  }
})
