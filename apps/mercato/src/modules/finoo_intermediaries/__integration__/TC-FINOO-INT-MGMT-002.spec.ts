import { expect, test } from '@playwright/test'
import { drainIntegrationQueue } from '@open-mercato/core/helpers/integration/queue'
import { createModuleQueue } from '@open-mercato/queue'
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
    const stored = await queryDatabase<{
      first_name: string
      last_name: string
      email: string
      token: string
      invitation_id: string
      invitation_expires_at: string
    }>(
      `select fi.first_name, fi.last_name, fi.email, cui.token,
              cui.id as invitation_id, cui.expires_at as invitation_expires_at
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

    const linked = await queryDatabase<{ customer_user_id: string }>(
      'select customer_user_id from finoo_intermediaries where id = $1',
      [invited.body.item.id],
    )
    await queryDatabase(
      `update finoo_intermediaries
          set lifecycle_state = 'invited', customer_user_id = null,
              invitation_id = $2, invitation_expires_at = $3, updated_at = now()
        where id = $1`,
      [invited.body.item.id, stored[0]!.invitation_id, stored[0]!.invitation_expires_at],
    )
    const reconciliationQueue = createModuleQueue<{
      tenantId: string
      organizationId: string
    }>('finoo-intermediaries-acceptance-reconciliation', { concurrency: 1 })
    await reconciliationQueue.enqueue({
      tenantId: scenario.tenantId,
      organizationId: scenario.organizationId,
    })
    expect(await drainIntegrationQueue('finoo-intermediaries-acceptance-reconciliation')).toBe(1)
    const reconciled = await queryDatabase<{ lifecycle_state: string; customer_user_id: string }>(
      'select lifecycle_state, customer_user_id from finoo_intermediaries where id = $1',
      [invited.body.item.id],
    )
    expect(reconciled[0]).toEqual({
      lifecycle_state: 'active',
      customer_user_id: linked[0]!.customer_user_id,
    })

    await reconciliationQueue.enqueue({
      tenantId: scenario.tenantId,
      organizationId: scenario.organizationId,
    })
    expect(await drainIntegrationQueue('finoo-intermediaries-acceptance-reconciliation')).toBe(1)
    expect(await queryDatabase<{ count: string }>(
      `select count(*)::text as count from finoo_intermediaries
        where id = $1 and lifecycle_state = 'active' and customer_user_id = $2`,
      [invited.body.item.id, linked[0]!.customer_user_id],
    )).toEqual([{ count: '1' }])
  } finally {
    await cleanupScenario(request, scenario)
  }
})
