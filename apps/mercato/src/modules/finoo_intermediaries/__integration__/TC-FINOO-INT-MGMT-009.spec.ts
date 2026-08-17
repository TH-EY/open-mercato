import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { portalCookieHeaders, portalLogin } from '@open-mercato/core/helpers/integration/customerAccountsFixtures'
import {
  cleanupScenario,
  createCustomerUser,
  createScenario,
  inviteIntermediary,
  queryDatabase,
  runLifecycleAction,
  scopedApiRequest,
  seedAssignment,
  type Scenario,
} from './helpers'

test('TC-FINOO-INT-MGMT-009 multi-role deactivate preserves history and revokes sessions', async ({ request }) => {
  let scenario: Scenario | null = null
  try {
    scenario = await createScenario(request, 'TC-FINOO-INT-MGMT-009')
    const secondaryResponse = await scopedApiRequest(request, scenario, 'POST', '/api/customer_accounts/admin/roles', {
      name: `Buyer ${randomUUID().slice(0, 8)}`,
      slug: `buyer-${randomUUID().slice(0, 8)}`,
      customerAssignable: false,
    })
    const secondaryRoleId = ((await secondaryResponse.json()) as { role: { id: string } }).role.id
    const user = await createCustomerUser(request, scenario, { roleIds: [secondaryRoleId] })
    const linked = await inviteIntermediary(request, scenario)
    const session = await portalLogin(request, { email: user.email, password: user.password, tenantId: scenario.tenantId })
    const assignmentId = await seedAssignment({ scenario, customerUserId: user.id })
    await queryDatabase(
      `insert into finoo_intermediary_notes
       (id, tenant_id, organization_id, assignment_id, author_customer_user_id, body, created_at, updated_at)
       values ($1,$2,$3,$4,$5,'preserved note',now(),now())`,
      [randomUUID(), scenario.tenantId, scenario.organizationId, assignmentId, user.id],
    )
    const deactivated = await runLifecycleAction(request, scenario, linked.body.item, 'deactivate')
    expect(deactivated.body.item.status).toBe('inactive')
    const state = (await queryDatabase<{ is_active: boolean; other_role: string; intermediary_role: string; assignments: string; notes: string; sessions: string }>(
      `select cu.is_active,
       (select count(*)::text from customer_user_roles where user_id=cu.id and role_id=$2 and deleted_at is null) other_role,
       (select count(*)::text from customer_user_roles where user_id=cu.id and role_id=$3 and deleted_at is null) intermediary_role,
       (select count(*)::text from finoo_intermediary_assignments where intermediary_customer_user_id=cu.id) assignments,
       (select count(*)::text from finoo_intermediary_notes where author_customer_user_id=cu.id) notes,
       (select count(*)::text from customer_user_sessions where user_id=cu.id and deleted_at is null) sessions
       from customer_users cu where cu.id=$1`,
      [user.id, secondaryRoleId, scenario.intermediaryRoleId],
    ))[0]!
    expect(state).toMatchObject({ is_active: false, other_role: '1', intermediary_role: '0', assignments: '1', notes: '1', sessions: '0' })
    expect([401, 403]).toContain((await request.get('/api/finoo_intermediaries/portal/deals', { headers: portalCookieHeaders(session) })).status())
    const reactivated = await runLifecycleAction(request, scenario, deactivated.body.item, 'reactivate')
    expect(reactivated.body.item.status).toBe('active')
    expect([401, 403]).toContain((await request.get('/api/finoo_intermediaries/portal/deals', { headers: portalCookieHeaders(session) })).status())
  } finally {
    await cleanupScenario(request, scenario)
  }
})
