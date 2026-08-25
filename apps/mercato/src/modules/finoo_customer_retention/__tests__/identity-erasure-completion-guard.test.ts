import { FinooCustomerRetentionState } from '../data/entities'
import { createFinooIdentityErasureCompletionGuard } from '../services/identityErasureCompletionGuard'
import { lockRetentionSubject } from '../services/retentionLock'

jest.mock('../services/retentionLock', () => ({
  lockRetentionSubject: jest.fn(async () => undefined),
}))

const scope = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
  customerEntityId: '33333333-3333-4333-8333-333333333333',
}

describe('Finoo identity erasure completion guard', () => {
  beforeEach(() => jest.clearAllMocks())

  it('clears the exact scoped completion marker under the shared retention lock', async () => {
    const state: { id: string; identityErasedAt: Date | null } = {
      id: 'state-1',
      identityErasedAt: new Date('2026-08-25T12:00:00.000Z'),
    }
    const em = {
      isInTransaction: jest.fn(() => true),
      findOne: jest.fn(async () => state),
      flush: jest.fn(async () => undefined),
    }

    await createFinooIdentityErasureCompletionGuard().invalidateForRawWrite({
      ...scope,
      em: em as never,
    })

    expect(lockRetentionSubject).toHaveBeenCalledWith(em, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
    }, scope.customerEntityId)
    expect(em.findOne).toHaveBeenCalledWith(FinooCustomerRetentionState, {
      ...scope,
      deletedAt: null,
    }, expect.objectContaining({ fields: ['id', 'identityErasedAt'] }))
    expect(state.identityErasedAt).toBeNull()
    expect(em.flush).toHaveBeenCalledTimes(1)
  })

  it('does not mutate foreign scope and rejects use outside the writer transaction', async () => {
    const em = {
      isInTransaction: jest.fn(() => false),
      findOne: jest.fn(),
      flush: jest.fn(),
    }

    await expect(createFinooIdentityErasureCompletionGuard().invalidateForRawWrite({
      ...scope,
      em: em as never,
    })).rejects.toThrow('only be invalidated transactionally')
    expect(lockRetentionSubject).not.toHaveBeenCalled()
    expect(em.findOne).not.toHaveBeenCalled()
  })
})
