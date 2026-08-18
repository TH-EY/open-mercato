const startJob = jest.fn()
const updateProgress = jest.fn()
const completeJob = jest.fn()
const failJob = jest.fn()
const execute = jest.fn()

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: jest.fn().mockResolvedValue({
    resolve: (name: string) => name === 'progressService'
      ? { startJob, updateProgress, completeJob, failJob }
      : { execute },
  }),
}))

import handle, { metadata } from '../payout-create'
import { FINOO_PAYOUT_MAX_ATTEMPTS } from '../../lib/payoutQueue'

const payload = {
  progressJobId: '00000000-0000-4000-8000-000000000001',
  paymentReference: 'FINOO-REF',
  affiliateUpdatedAt: '2026-08-13T10:00:00.000Z',
  transactions: [{ id: '00000000-0000-4000-8000-000000000002', updatedAt: '2026-08-13T11:00:00.000Z' }],
  tenantId: '00000000-0000-4000-8000-000000000003',
  organizationId: '00000000-0000-4000-8000-000000000004',
  userId: '00000000-0000-4000-8000-000000000005',
}

describe('payout worker', () => {
  beforeEach(() => jest.clearAllMocks())

  it('preserves a queued legacy single-group payload and completes progress after commit', async () => {
    execute.mockResolvedValue({ result: { id: 'payout', paymentReference: payload.paymentReference } })
    await handle({ payload } as never, {} as never)
    expect(metadata.queue).toBe('finoo-affiliates-payout-create')
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledWith('finoo_affiliates.payout.create', expect.objectContaining({
      input: expect.objectContaining({ paymentReference: payload.paymentReference }),
    }))
    expect(completeJob).toHaveBeenCalledWith(payload.progressJobId, expect.objectContaining({ resultSummary: { payoutIds: ['payout'], paymentReferences: [payload.paymentReference] } }), expect.anything())
    expect(failJob).not.toHaveBeenCalled()
  })

  it('executes a server-bound batch with its aggregate identifier', async () => {
    execute.mockResolvedValue({ result: { payouts: [{ id: 'payout' }], paymentReferences: [payload.paymentReference] } })
    const batchPayload = {
      progressJobId: payload.progressJobId,
      batchId: '00000000-0000-4000-8000-000000000006',
      groups: [{
        paymentReference: payload.paymentReference,
        affiliateUpdatedAt: payload.affiliateUpdatedAt,
        transactions: payload.transactions,
      }],
      tenantId: payload.tenantId,
      organizationId: payload.organizationId,
      userId: payload.userId,
    }
    await handle({ payload: batchPayload } as never, {} as never)
    expect(execute).toHaveBeenCalledWith('finoo_affiliates.payout_batch.create', expect.objectContaining({
      input: expect.objectContaining({ batchId: batchPayload.batchId, groups: batchPayload.groups }),
    }))
  })

  it('keeps progress non-terminal while the queue can retry the same reference', async () => {
    execute.mockRejectedValue(new Error('retry'))
    await expect(handle({ payload } as never, { attemptNumber: 1 } as never)).rejects.toThrow('retry')
    expect(failJob).not.toHaveBeenCalled()
    expect(completeJob).not.toHaveBeenCalled()
  })

  it('marks progress failed only after the queue exhausts all attempts', async () => {
    execute.mockRejectedValue(new Error('terminal'))
    await expect(handle({ payload } as never, { attemptNumber: FINOO_PAYOUT_MAX_ATTEMPTS } as never)).rejects.toThrow('terminal')
    expect(failJob).toHaveBeenCalledWith(payload.progressJobId, expect.anything(), expect.anything())
  })

  it('converges to completed when progress completion fails after commit and a retry succeeds', async () => {
    execute.mockResolvedValue({ result: { id: 'payout', paymentReference: payload.paymentReference } })
    completeJob.mockRejectedValueOnce(new Error('progress unavailable')).mockResolvedValueOnce(undefined)

    await expect(handle({ payload } as never, { attemptNumber: 1 } as never)).rejects.toThrow('progress unavailable')
    expect(failJob).not.toHaveBeenCalled()

    await handle({ payload } as never, { attemptNumber: 2 } as never)
    expect(execute).toHaveBeenCalledTimes(2)
    expect(completeJob).toHaveBeenCalledTimes(2)
    expect(failJob).not.toHaveBeenCalled()
  })
})
