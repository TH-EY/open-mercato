import { LockMode } from '@mikro-orm/core'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { enforceCommandOptimisticLockWithGuards } from '@open-mercato/shared/lib/crud/optimistic-lock-command'
import { transitionAffiliateTransaction, undoAffiliateTransactionTransition } from '../transactions'

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({ findOneWithDecryption: jest.fn() }))
jest.mock('@open-mercato/shared/lib/crud/optimistic-lock-command', () => ({
  enforceCommandOptimisticLockWithGuards: jest.fn().mockResolvedValue(undefined),
}))

const findOne = jest.mocked(findOneWithDecryption)
const enforceGuard = jest.mocked(enforceCommandOptimisticLockWithGuards)
const scope = { tenantId: 'tenant-1', organizationId: 'organization-1' }

function transactionalEm() {
  const transactional = { flush: jest.fn().mockResolvedValue(undefined) }
  return {
    transactional,
    em: { transactional: (callback: (trx: unknown) => unknown) => callback(transactional) },
  }
}

describe('affiliate transaction row locking', () => {
  beforeEach(() => jest.clearAllMocks())

  it('locks the scoped row and awaits the DI optimistic guard before transition', async () => {
    const transaction = {
      id: 'transaction-1',
      commissionStatus: 'processing',
      commissionStatusEntryId: 'processing-1',
      updatedAt: new Date('2026-08-13T10:00:00.000Z'),
    }
    findOne
      .mockResolvedValueOnce(transaction as never)
      .mockResolvedValueOnce({ id: 'dictionary-1' } as never)
      .mockResolvedValueOnce({ id: 'approved-1' } as never)
    const harness = transactionalEm()

    await transitionAffiliateTransaction(
      harness.em as never,
      {} as never,
      { id: transaction.id, action: 'accept', updatedAt: transaction.updatedAt.toISOString() },
      scope,
    )

    expect(findOne.mock.calls[0]?.[3]).toEqual({ lockMode: LockMode.PESSIMISTIC_WRITE })
    expect(findOne.mock.calls[0]?.[2]).toMatchObject({ id: transaction.id, ...scope })
    expect(enforceGuard).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      resourceId: transaction.id,
      expected: '2026-08-13T10:00:00.000Z',
    }))
    expect(transaction.commissionStatus).toBe('approved')
  })

  it('undo locks and restores only an unchanged non-paid after-state', async () => {
    const transaction = {
      id: 'transaction-1',
      commissionStatus: 'approved',
      commissionStatusEntryId: 'approved-1',
      updatedAt: new Date('2026-08-13T11:00:00.000Z'),
    }
    findOne
      .mockResolvedValueOnce(transaction as never)
      .mockResolvedValueOnce({ id: 'dictionary-1' } as never)
      .mockResolvedValueOnce({ id: 'processing-1' } as never)
    const harness = transactionalEm()

    await undoAffiliateTransactionTransition(harness.em as never, {
      id: transaction.id,
      scope,
      beforeStatus: 'processing',
      afterStatus: 'approved',
      afterUpdatedAt: transaction.updatedAt.toISOString(),
    })

    expect(findOne.mock.calls[0]?.[3]).toEqual({ lockMode: LockMode.PESSIMISTIC_WRITE })
    expect(transaction.commissionStatus).toBe('processing')
    expect(transaction.commissionStatusEntryId).toBe('processing-1')
  })

  it.each([
    ['paid_out', 'approved'],
    ['rejected', 'approved'],
  ] as const)('undo refuses current %s when captured after status is %s', async (current, afterStatus) => {
    findOne.mockResolvedValueOnce({
      id: 'transaction-1',
      commissionStatus: current,
      updatedAt: new Date('2026-08-13T11:00:00.000Z'),
    } as never)
    const harness = transactionalEm()
    await expect(undoAffiliateTransactionTransition(harness.em as never, {
      id: 'transaction-1',
      scope,
      beforeStatus: 'processing',
      afterStatus,
      afterUpdatedAt: '2026-08-13T11:00:00.000Z',
    })).rejects.toMatchObject({ status: 409, body: { code: 'AFFILIATE_TRANSACTION_UNDO_CONFLICT' } })
  })
})
