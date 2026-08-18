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

import handle, { metadata } from '../assignment-bulk'
import { FINOO_INTERMEDIARY_BULK_ASSIGNMENT_MAX_ATTEMPTS } from '../../lib/bulkAssignmentQueue'

const payload = {
  progressJobId: '00000000-0000-4000-8000-000000000001',
  tenantId: '00000000-0000-4000-8000-000000000002',
  organizationId: '00000000-0000-4000-8000-000000000003',
  userId: '00000000-0000-4000-8000-000000000004',
  failureMessage: 'Localized safe failure',
  intermediaryCustomerUserId: '00000000-0000-4000-8000-000000000005',
  confirmReassign: false,
  deals: [{
    id: '00000000-0000-4000-8000-000000000006',
    updatedAt: '2026-08-18T10:00:00.000Z',
    assignmentId: null,
    assignmentUpdatedAt: null,
  }],
}

describe('bulk assignment worker', () => {
  beforeEach(() => jest.clearAllMocks())

  it('uses the progress id as the idempotent operation id and reports only ids and counts', async () => {
    execute.mockResolvedValue({ result: { assignmentIds: ['assignment'], createdCount: 1, reassignedCount: 0, unchangedCount: 0 } })
    await handle({ payload } as never, {} as never)
    expect(metadata.queue).toBe('finoo-intermediaries-assignment-bulk')
    expect(execute).toHaveBeenCalledWith('finoo_intermediaries.assignment.bulk_upsert', expect.objectContaining({
      input: expect.objectContaining({ operationId: payload.progressJobId, deals: payload.deals }),
      ctx: expect.objectContaining({ systemActor: true }),
    }))
    expect(completeJob).toHaveBeenCalledWith(payload.progressJobId, {
      resultSummary: { assignmentIds: ['assignment'], createdCount: 1, reassignedCount: 0, unchangedCount: 0 },
    }, expect.anything())
  })

  it('keeps progress non-terminal while queue retries use the same operation id', async () => {
    execute.mockRejectedValue(new Error('retry'))
    await expect(handle({ payload } as never, { attemptNumber: 1 } as never)).rejects.toThrow('retry')
    expect(failJob).not.toHaveBeenCalled()
  })

  it('fails progress with the safe localized message after all attempts are exhausted', async () => {
    execute.mockRejectedValue(new Error('terminal'))
    await expect(handle({ payload } as never, { attemptNumber: FINOO_INTERMEDIARY_BULK_ASSIGNMENT_MAX_ATTEMPTS } as never)).rejects.toThrow('terminal')
    expect(failJob).toHaveBeenCalledWith(payload.progressJobId, {
      errorMessage: payload.failureMessage,
    }, expect.anything())
  })

  it('converges to completed when progress completion fails after the receipt commit', async () => {
    execute.mockResolvedValue({ result: { assignmentIds: ['assignment'], createdCount: 1, reassignedCount: 0, unchangedCount: 0 } })
    completeJob.mockRejectedValueOnce(new Error('progress unavailable')).mockResolvedValueOnce(undefined)

    await expect(handle({ payload } as never, { attemptNumber: 1 } as never)).rejects.toThrow('progress unavailable')
    expect(failJob).not.toHaveBeenCalled()

    await handle({ payload } as never, { attemptNumber: 2 } as never)
    expect(execute).toHaveBeenCalledTimes(2)
    expect(completeJob).toHaveBeenCalledTimes(2)
    expect(failJob).not.toHaveBeenCalled()
  })
})
