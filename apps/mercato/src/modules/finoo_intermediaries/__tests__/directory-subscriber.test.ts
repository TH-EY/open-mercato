/** @jest-environment node */

import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import handle, { metadata } from '../subscribers/customer-invitation-accepted'

const tenantId = '11111111-1111-4111-8111-111111111111'
const invitationId = '22222222-2222-4222-8222-222222222222'
const userId = '33333333-3333-4333-8333-333333333333'

function context(execute: jest.Mock) {
  const container = {
    resolve(token: string) {
      if (token === 'commandBus') return { execute }
      throw new Error(`Unexpected dependency: ${token}`)
    },
  }
  return { ...container, container } as never
}

describe('customer invitation accepted subscriber', () => {
  it('is unique, persistent, and executes the scoped system command idempotently', async () => {
    const execute = jest.fn(async () => ({ result: {}, logEntry: null }))
    const payload = { invitationId, userId, tenantId }

    await handle(payload, context(execute))
    await handle(payload, context(execute))

    expect(metadata).toEqual({
      event: 'customer_accounts.invitation.accepted',
      persistent: true,
      id: 'finoo_intermediaries:customer-invitation-accepted',
    })
    expect(execute).toHaveBeenCalledTimes(2)
    expect(execute).toHaveBeenLastCalledWith(
      'finoo_intermediaries.intermediary.activate_from_invitation',
      expect.objectContaining({
        input: payload,
        ctx: expect.objectContaining({
          auth: null,
          systemActor: true,
          selectedOrganizationId: null,
          organizationIds: null,
        }),
        metadata: expect.objectContaining({ tenantId, resourceId: invitationId }),
      }),
    )
  })

  it('ignores malformed or extended payloads without executing a command', async () => {
    const execute = jest.fn()
    await handle({ invitationId, userId }, context(execute))
    await handle({ invitationId, userId, tenantId, organizationId: userId }, context(execute))
    expect(execute).not.toHaveBeenCalled()
  })

  it('fails closed on stale scoped relationships and rethrows transient failures for retry', async () => {
    const stale = jest.fn(async () => {
      throw new CrudHttpError(409, { error: 'conflict' })
    })
    await expect(handle({ invitationId, userId, tenantId }, context(stale))).resolves.toBeUndefined()

    const transient = jest.fn(async () => { throw new Error('database unavailable') })
    await expect(handle({ invitationId, userId, tenantId }, context(transient)))
      .rejects.toThrow('database unavailable')
  })
})
