import { expect, test } from '@playwright/test'
import { drainIntegrationQueue } from '@open-mercato/core/helpers/integration/queue'
import {
  acceptInvitation,
  cleanupScenario,
  createScenario,
  inviteIntermediary,
  invitationToken,
  listDirectory,
  updateIntermediary,
  waitForCapturedEmail,
  type Scenario,
} from './helpers'

test('TC-FINOO-INT-MGMT-006 pre-activation email edit invalidates token and post-link email is immutable', async ({ request }) => {
  let scenario: Scenario | null = null
  try {
    scenario = await createScenario(request, 'TC-FINOO-INT-MGMT-006')
    const invited = await inviteIntermediary(request, scenario)
    const oldToken = invitationToken(await waitForCapturedEmail(scenario.recipient))
    const replacementEmail = `replacement-${scenario.recipient}`
    const replaced = await updateIntermediary(request, scenario, invited.body.item, {
      firstName: 'Administrator',
      lastName: 'Owned',
      email: replacementEmail,
    })
    expect(replaced.response.status()).toBe(200)
    expect((await acceptInvitation(request, oldToken)).status()).toBe(400)
    const currentToken = invitationToken(await waitForCapturedEmail(replacementEmail))
    expect((await acceptInvitation(request, currentToken, 'Portal Renamed User')).status()).toBe(201)
    await drainIntegrationQueue('events')
    const active = (await listDirectory(request, scenario, `?search=${encodeURIComponent(replacementEmail)}`)).items[0]
    expect(active).toMatchObject({ firstName: 'Administrator', lastName: 'Owned', status: 'active' })
    const rejected = await updateIntermediary(request, scenario, active, {
      firstName: 'Still',
      lastName: 'Admin Owned',
      email: `forbidden-${replacementEmail}`,
    })
    expect(rejected.response.status(), JSON.stringify(rejected.body)).toBe(409)
  } finally {
    await cleanupScenario(request, scenario)
  }
})
