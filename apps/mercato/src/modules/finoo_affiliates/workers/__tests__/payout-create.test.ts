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

  it('executes exactly one aggregate command and completes progress after commit', async () => {
    execute.mockResolvedValue({ result: { id: 'payout', paymentReference: payload.paymentReference } })
    await handle({ payload } as never, {} as never)
    expect(metadata.queue).toBe('finoo-affiliates-payout-create')
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledWith('finoo_affiliates.payout.create', expect.objectContaining({
      input: expect.objectContaining({ paymentReference: payload.paymentReference }),
    }))
    expect(completeJob).toHaveBeenCalledWith(payload.progressJobId, expect.objectContaining({ resultSummary: { payoutId: 'payout', paymentReference: payload.paymentReference } }), expect.anything())
    expect(failJob).not.toHaveBeenCalled()
  })

  it('marks progress failed and rethrows so the queue can retry the same reference', async () => {
    execute.mockRejectedValue(new Error('retry'))
    await expect(handle({ payload } as never, {} as never)).rejects.toThrow('retry')
    expect(failJob).toHaveBeenCalledWith(payload.progressJobId, expect.anything(), expect.anything())
    expect(completeJob).not.toHaveBeenCalled()
  })
})
