import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import setup from '../setup'
import {
  reconcileAcceptedIntermediaryInvitations,
} from '../lib/directoryAcceptanceReconciliation'

describe('intermediary invitation acceptance reconciliation', () => {
  it('selects accepted pending rows by exact scope and activates a bounded page', async () => {
    const execute = jest.fn().mockResolvedValue([
      {
        invitation_id: '33333333-3333-4333-8333-333333333333',
        user_id: '44444444-4444-4444-8444-444444444444',
        accepted_at: new Date('2026-08-17T10:00:00.000Z'),
      },
    ])
    const activate = jest.fn().mockResolvedValue(true)

    const result = await reconcileAcceptedIntermediaryInvitations(
      { getConnection: () => ({ execute }) } as never,
      {
        tenantId: '11111111-1111-4111-8111-111111111111',
        organizationId: '22222222-2222-4222-8222-222222222222',
      },
      activate,
      { batchSize: 25 },
    )

    expect(result).toEqual({
      selected: 1,
      succeeded: 1,
      failed: 0,
      continuation: {
        acceptedAt: '2026-08-17T10:00:00.000Z',
        invitationId: '33333333-3333-4333-8333-333333333333',
      },
    })
    expect(execute.mock.calls[0]?.[0]).toContain('from finoo_intermediaries intermediary')
    expect(execute.mock.calls[0]?.[0]).toContain('invitation.accepted_at is not null')
    expect(execute.mock.calls[0]?.[0]).toContain("intermediary.lifecycle_state in ('delivery_failed', 'invited')")
    expect(execute.mock.calls[0]?.[1]).toEqual([
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      25,
    ])
    expect(activate).toHaveBeenCalledWith({
      invitationId: '33333333-3333-4333-8333-333333333333',
      userId: '44444444-4444-4444-8444-444444444444',
    })
  })

  it('isolates failures and continues the durable reconciliation page', async () => {
    const execute = jest.fn().mockResolvedValue([
      { invitation_id: 'invite-1', user_id: 'user-1', accepted_at: '2026-08-17T10:00:00.000Z' },
      { invitation_id: 'invite-2', user_id: 'user-2', accepted_at: '2026-08-17T11:00:00.000Z' },
    ])
    const failure = new Error('transient database failure')
    const activate = jest.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(true)
    const onFailure = jest.fn()

    const result = await reconcileAcceptedIntermediaryInvitations(
      { getConnection: () => ({ execute }) } as never,
      { tenantId: 'tenant-1', organizationId: 'org-1' },
      activate,
      { onFailure },
    )

    expect(onFailure).toHaveBeenCalledWith('invite-1', failure)
    expect(activate).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({ selected: 2, succeeded: 1, failed: 1 })
  })

  it('registers an idempotent organization schedule and paginates the worker queue', async () => {
    const register = jest.fn().mockResolvedValue(undefined)
    await setup.seedDefaults?.({
      em: {} as never,
      tenantId: '11111111-1111-4111-8111-111111111111',
      organizationId: '22222222-2222-4222-8222-222222222222',
      container: {
        hasRegistration: () => true,
        resolve: () => ({ register }),
      } as never,
    })

    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      scheduleType: 'interval',
      scheduleValue: '1m',
      targetQueue: 'finoo-intermediaries-acceptance-reconciliation',
      targetPayload: {
        tenantId: '11111111-1111-4111-8111-111111111111',
        organizationId: '22222222-2222-4222-8222-222222222222',
      },
    }))
    const worker = readFileSync(
      resolve(process.cwd(), 'src/modules/finoo_intermediaries/workers/acceptance-reconciliation.ts'),
      'utf8',
    )
    expect(worker).toContain('afterAcceptedAt: result.continuation.acceptedAt')
    expect(worker).toContain("'finoo_intermediaries.intermediary.activate_from_invitation'")
  })
})
