import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createRoleFixture, createUserFixture, setRoleAclFeatures } from '@open-mercato/core/helpers/integration/authFixtures'
import {
  DIRECTORY_PATH,
  cleanupScenario,
  createCustomerUser,
  createScenario,
  inviteIntermediary,
  listDirectory,
  queryDatabase,
  runLifecycleAction,
  scopedApiRequest,
  seedAssignment,
  type Scenario,
} from './helpers'

test('TC-FINOO-INT-MGMT-001 all statuses/counts and complete view/manage ACL', async ({ request }) => {
  let scenario: Scenario | null = null
  try {
    scenario = await createScenario(request, 'TC-FINOO-INT-MGMT-001')
    const invited = await inviteIntermediary(request, scenario, { email: `invited-${scenario.recipient}` })
    const activeUser = await createCustomerUser(request, scenario, { email: `active-${scenario.recipient}` })
    const active = await inviteIntermediary(request, scenario, { email: activeUser.email })
    await seedAssignment({ scenario, customerUserId: activeUser.id })
    await seedAssignment({ scenario, customerUserId: activeUser.id })
    const inactiveUser = await createCustomerUser(request, scenario, { email: `inactive-${scenario.recipient}` })
    const inactiveSource = await inviteIntermediary(request, scenario, { email: inactiveUser.email })
    const inactive = await runLifecycleAction(request, scenario, inactiveSource.body.item, 'deactivate')
    await queryDatabase(
      "update communication_channels set status='error',is_active=false where id=$1",
      [scenario.systemEmailChannelId],
    )
    const failed = await inviteIntermediary(request, scenario, { email: `failed-${scenario.recipient}` })
    expect(failed.response.status()).toBe(502)
    await queryDatabase(
      'update communication_channels set deleted_at=now() where id=$1',
      [scenario.systemEmailChannelId],
    )
    const expired = await inviteIntermediary(request, scenario, { email: `expired-${scenario.recipient}` })
    await queryDatabase('update finoo_intermediaries set invitation_expires_at=now()-interval \'1 minute\' where id=$1', [expired.body.item.id])

    const suffix = randomUUID().slice(0, 8)
    const viewerRoleId = await createRoleFixture(request, scenario.superToken, { name: `Directory viewer ${suffix}`, tenantId: scenario.tenantId })
    await setRoleAclFeatures(request, scenario.superToken, { roleId: viewerRoleId, features: ['finoo_intermediaries.view'], organizations: [scenario.organizationId] })
    const viewerEmail = `viewer-${suffix}@test.local`
    const viewerPassword = `Aa1!${suffix}`
    await createUserFixture(request, scenario.superToken, { email: viewerEmail, password: viewerPassword, organizationId: scenario.organizationId, roles: [viewerRoleId] })
    const viewer = { ...scenario, token: await getAuthToken(request, viewerEmail, viewerPassword) }
    const list = await listDirectory(request, viewer)
    expect(new Set(list.items.map((item) => item.status))).toEqual(new Set(['invited', 'active', 'inactive', 'delivery_failed', 'expired']))
    expect(list.items.find((item) => item.id === active.body.item.id)?.relatedDeals).toBe(2)

    const forbiddenRequests: Array<Promise<{ status(): number }>> = [
      scopedApiRequest(request, viewer, 'POST', `${DIRECTORY_PATH}/invite`, { email: `denied-${scenario.recipient}`, firstName: 'No', lastName: 'Access' }),
      scopedApiRequest(request, viewer, 'PUT', `${DIRECTORY_PATH}/${invited.body.item.id}`, { firstName: 'No', lastName: 'Access', expectedUpdatedAt: invited.body.item.updatedAt }),
      scopedApiRequest(request, viewer, 'POST', `${DIRECTORY_PATH}/${invited.body.item.id}/resend`, { expectedUpdatedAt: invited.body.item.updatedAt }),
      scopedApiRequest(request, viewer, 'POST', `${DIRECTORY_PATH}/${invited.body.item.id}/cancel-invitation`, { expectedUpdatedAt: invited.body.item.updatedAt }),
      scopedApiRequest(request, viewer, 'POST', `${DIRECTORY_PATH}/${active.body.item.id}/deactivate`, { expectedUpdatedAt: active.body.item.updatedAt }),
      scopedApiRequest(request, viewer, 'POST', `${DIRECTORY_PATH}/${inactive.body.item.id}/reactivate`, { expectedUpdatedAt: inactive.body.item.updatedAt }),
    ]
    expect((await Promise.all(forbiddenRequests)).map((response) => response.status())).toEqual([403, 403, 403, 403, 403, 403])

    const superRoleId = await createRoleFixture(request, scenario.superToken, { name: `Tenant superadmin ${suffix}`, tenantId: scenario.tenantId })
    await setRoleAclFeatures(request, scenario.superToken, { roleId: superRoleId, features: [], organizations: [scenario.organizationId] })
    await queryDatabase('update role_acls set is_super_admin=true where role_id=$1', [superRoleId])
    const superEmail = `tenant-super-${suffix}@test.local`
    await createUserFixture(request, scenario.superToken, { email: superEmail, password: viewerPassword, organizationId: scenario.organizationId, roles: [superRoleId] })
    const tenantSuper = { ...scenario, token: await getAuthToken(request, superEmail, viewerPassword) }
    const superMutation = await inviteIntermediary(request, tenantSuper, { email: `super-${scenario.recipient}` })
    expect([200, 201]).toContain(superMutation.response.status())
  } finally {
    await cleanupScenario(request, scenario)
  }
})
