import { expect, test } from '@playwright/test'
import { seedSystemEmailChannel } from '@open-mercato/core/helpers/integration/communicationChannelsFixtures'
import {
  cleanupScenario,
  createCustomerUser,
  createScenario,
  inviteIntermediary,
  queryDatabase,
  type Scenario,
} from './helpers'

test('TC-FINOO-INT-MGMT-007 active existing account gets one membership and no invitation', async ({ request }) => {
  let scenario: Scenario | null = null
  try {
    scenario = await createScenario(request, 'TC-FINOO-INT-MGMT-007')
    const user = await createCustomerUser(request, scenario)
    const channelId = await seedSystemEmailChannel(request, scenario.token, {
      displayName: 'TC-007 unavailable access-notice channel',
      externalIdentifier: `system-${scenario.recipient}`,
    })
    await queryDatabase("update communication_channels set status='error', is_active=false where id=$1", [channelId])
    const linked = await inviteIntermediary(request, scenario)
    expect(linked.response.status()).toBe(200)
    expect(linked.body).toMatchObject({
      warningCode: 'access_notice_delivery_failed',
      item: { status: 'active', hasLinkedAccount: true, lastEmailStatus: 'failed' },
    })
    const rows = await queryDatabase<{ invitations: string; memberships: string }>(
      `select
        (select count(*)::text from customer_user_invitations where tenant_id=$1 and organization_id=$2) invitations,
        (select count(*)::text from customer_user_roles where user_id=$3 and role_id=$4 and deleted_at is null) memberships`,
      [scenario.tenantId, scenario.organizationId, user.id, scenario.intermediaryRoleId],
    )
    expect(rows[0]).toEqual({ invitations: '0', memberships: '1' })
  } finally {
    await cleanupScenario(request, scenario)
  }
})
