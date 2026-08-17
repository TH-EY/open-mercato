import { expect, test } from '@playwright/test'
import {
  acceptInvitation,
  cleanupScenario,
  createScenario,
  inviteIntermediary,
  invitationToken,
  queryDatabase,
  runLifecycleAction,
  waitForCapturedEmail,
  type Scenario,
} from './helpers'

test('TC-FINOO-INT-MGMT-004 real synchronous failure, Retry rotation, and stale CAS', async ({ request }) => {
  let scenario: Scenario | null = null
  try {
    scenario = await createScenario(request, 'TC-FINOO-INT-MGMT-004')
    await queryDatabase(
      "update communication_channels set status='error', is_active=false where id=$1",
      [scenario.systemEmailChannelId],
    )
    const failed = await inviteIntermediary(request, scenario)
    expect(failed.response.status()).toBe(502)
    expect(failed.body).toMatchObject({
      code: 'invitation_delivery_failed',
      item: { status: 'delivery_failed', lastEmailStatus: 'failed', lastEmailErrorCode: 'email_delivery_failed' },
    })
    const failedToken = invitationToken(await waitForCapturedEmail(scenario.recipient))
    const failedVersion = failed.body.item.updatedAt
    await queryDatabase(
      'update communication_channels set deleted_at=now() where id=$1',
      [scenario.systemEmailChannelId],
    )
    const retried = await runLifecycleAction(request, scenario, failed.body.item, 'resend')
    expect(retried.response.status()).toBe(200)
    expect(retried.body.item.status).toBe('invited')
    const freshToken = invitationToken(await waitForCapturedEmail(scenario.recipient))
    expect(freshToken).not.toBe(failedToken)
    expect((await acceptInvitation(request, failedToken)).status()).toBe(400)
    const stale = await queryDatabase<{ id: string }>(
      `update finoo_intermediaries set lifecycle_state='delivery_failed'
       where id=$1 and updated_at=$2 returning id`,
      [failed.body.item.id, failedVersion],
    )
    expect(stale).toHaveLength(0)
  } finally {
    await cleanupScenario(request, scenario)
  }
})
