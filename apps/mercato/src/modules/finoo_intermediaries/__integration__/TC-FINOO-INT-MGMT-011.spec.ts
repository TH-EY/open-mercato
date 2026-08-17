import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { createOrganizationFixture, deleteOrganizationIfExists, setRoleAclFeatures } from '@open-mercato/core/helpers/integration/authFixtures'
import {
  cleanupScenario,
  createCustomerUser,
  createScenario,
  inviteIntermediary,
  listDirectory,
  queryDatabase,
  runLifecycleAction,
  scopedApiRequest,
  type Scenario,
} from './helpers'

test('TC-FINOO-INT-MGMT-011 forged, cross-scope, ambiguous, duplicate, and stale writes fail closed', async ({ request }) => {
  let owner: Scenario | null = null
  let foreignTenant: Scenario | null = null
  let siblingOrganizationId: string | null = null
  try {
    owner = await createScenario(request, 'TC-FINOO-INT-MGMT-011-A')
    foreignTenant = await createScenario(request, 'TC-FINOO-INT-MGMT-011-B')
    const invited = await inviteIntermediary(request, owner)

    const crossTenant = await scopedApiRequest(
      request, foreignTenant, 'POST',
      `/api/finoo_intermediaries/admin/directory/${invited.body.item.id}/cancel-invitation`,
      { expectedUpdatedAt: invited.body.item.updatedAt },
    )
    expect([404, 409]).toContain(crossTenant.status())
    const forgedRecord = await scopedApiRequest(
      request, owner, 'POST',
      `/api/finoo_intermediaries/admin/directory/${randomUUID()}/deactivate`,
      { expectedUpdatedAt: new Date().toISOString() },
    )
    expect(forgedRecord.status()).toBe(404)

    siblingOrganizationId = await createOrganizationFixture(request, owner.superToken, {
      name: `TC-011 sibling ${randomUUID().slice(0, 8)}`,
      tenantId: owner.tenantId,
    })
    await setRoleAclFeatures(request, owner.superToken, {
      roleId: owner.staffRoleId,
      features: [
        'finoo_intermediaries.view', 'finoo_intermediaries.manage',
        'customer_accounts.view', 'customer_accounts.manage',
        'customer_accounts.roles.manage', 'customer_accounts.invite',
      ],
      organizations: [owner.organizationId, siblingOrganizationId],
    })
    const crossOrganizationUser = await createCustomerUser(request, owner, { email: `foreign-${owner.recipient}` })
    await queryDatabase(
      'update customer_users set organization_id=$2 where id=$1 and tenant_id=$3',
      [crossOrganizationUser.id, siblingOrganizationId, owner.tenantId],
    )
    expect((await inviteIntermediary(request, owner, { email: `foreign-${owner.recipient}` })).response.status()).toBe(409)

    await queryDatabase('update customer_roles set deleted_at=now() where id=$1', [owner.intermediaryRoleId])
    expect((await inviteIntermediary(request, owner, { email: `role-${owner.recipient}` })).response.status()).toBe(422)
    await queryDatabase('update customer_roles set deleted_at=null where id=$1', [owner.intermediaryRoleId])

    const raceEmail = `race-${owner.recipient}`
    const race = await Promise.all([
      inviteIntermediary(request, owner, { email: raceEmail, firstName: 'First' }),
      inviteIntermediary(request, owner, { email: raceEmail, firstName: 'Second' }),
    ])
    expect(race.some(({ response }) => [200, 201].includes(response.status()))).toBeTruthy()
    const matchingRaceRows = (await listDirectory(request, owner, `?search=${encodeURIComponent(raceEmail)}`)).items
    expect(matchingRaceRows).toHaveLength(1)

    const cancelled = await runLifecycleAction(request, owner, invited.body.item, 'cancel-invitation')
    expect(cancelled.response.status()).toBe(200)
    expect((await runLifecycleAction(request, owner, invited.body.item, 'cancel-invitation')).response.status()).toBe(409)

    await queryDatabase(
      `update finoo_intermediaries set lifecycle_state='active', customer_user_id=$2,
       invitation_id=null, invitation_expires_at=null, updated_at=now() where id=$1`,
      [cancelled.body.item.id, randomUUID()],
    )
    const forgedAccount = (await listDirectory(request, owner)).items.find((item) => item.id === cancelled.body.item.id)!
    expect((await runLifecycleAction(request, owner, forgedAccount, 'deactivate')).response.status()).toBe(404)
  } finally {
    if (owner && siblingOrganizationId) {
      await queryDatabase('delete from customer_user_roles where user_id in (select id from customer_users where tenant_id=$1 and organization_id=$2)', [owner.tenantId, siblingOrganizationId])
      await queryDatabase('delete from customer_users where tenant_id=$1 and organization_id=$2', [owner.tenantId, siblingOrganizationId])
      await deleteOrganizationIfExists(request, owner.superToken, siblingOrganizationId)
    }
    await cleanupScenario(request, foreignTenant)
    await cleanupScenario(request, owner)
  }
})
