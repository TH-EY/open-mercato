const enqueue = jest.fn()

jest.mock('../lib/reconciliationQueue', () => ({
  getFinooCustomerRetentionReconciliationQueue: () => ({ enqueue }),
}))

import handle, { metadata } from '../workers/reconcile'

describe('Finoo customer retention reconciliation worker', () => {
  beforeEach(() => enqueue.mockReset())

  it('uses a single worker lane and ignores stale generations', async () => {
    const reconcilePage = jest.fn().mockResolvedValue({
      selected: 0,
      processed: 0,
      changed: 0,
      nextCustomerEntityId: null,
      reconciliationGeneration: 8,
      staleGeneration: true,
    })
    await handle({
      id: 'job-1',
      createdAt: '2026-08-24T12:00:00.000Z',
      payload: {
        tenantId: 'tenant-1',
        organizationId: 'org-1',
        reconciliationGeneration: 7,
      },
    }, {
      jobId: 'job-1',
      attemptNumber: 1,
      queueName: metadata.queue,
      resolve: () => ({ reconcilePage }),
    })
    expect(metadata.concurrency).toBe(1)
    expect(reconcilePage).toHaveBeenCalledWith(expect.objectContaining({
      reconciliationGeneration: 7,
    }))
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('enqueues a flat generation-bound keyset continuation', async () => {
    const reconcilePage = jest.fn().mockResolvedValue({
      selected: 200,
      processed: 200,
      changed: 12,
      nextCustomerEntityId: 'person-200',
      reconciliationGeneration: 9,
      staleGeneration: false,
    })
    await handle({
      id: 'job-2',
      createdAt: '2026-08-24T12:00:00.000Z',
      payload: { tenantId: 'tenant-1', organizationId: 'org-1' },
    }, {
      jobId: 'job-2',
      attemptNumber: 1,
      queueName: metadata.queue,
      resolve: (name: string) => name === 'em'
        ? { fork: () => ({ find: jest.fn().mockResolvedValue([]) }) }
        : { reconcilePage },
    } as never)
    expect(enqueue).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      organizationId: 'org-1',
      progressJobId: undefined,
      actorUserId: undefined,
      afterCustomerEntityId: 'person-200',
      reconciliationGeneration: 9,
    })
  })

  it('recovers pending settings jobs during the hourly scoped run', async () => {
    const reconcilePage = jest.fn().mockResolvedValue({
      selected: 0,
      processed: 0,
      changed: 0,
      nextCustomerEntityId: null,
      reconciliationGeneration: 11,
      staleGeneration: false,
    })
    const find = jest.fn().mockResolvedValue([{
      id: 'progress-1',
      startedByUserId: 'user-1',
      meta: { reconciliationGeneration: 11 },
    }])
    await handle({
      id: 'job-3',
      createdAt: '2026-08-24T12:00:00.000Z',
      payload: { tenantId: 'tenant-1', organizationId: 'org-1' },
    }, {
      jobId: 'job-3',
      attemptNumber: 1,
      queueName: metadata.queue,
      resolve: (name: string) => name === 'em' ? { fork: () => ({ find }) } : { reconcilePage },
    } as never)
    expect(find).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      jobType: 'finoo_customer_retention.reconcile',
      status: { $in: ['pending', 'running'] },
      updatedAt: { $lte: expect.any(Date) },
    }), expect.objectContaining({ limit: 100 }))
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      progressJobId: 'progress-1',
      reconciliationGeneration: 11,
    }))
  })

  it('repairs a failed continuation enqueue without advancing progress twice', async () => {
    const progressJob = {
      id: 'progress-1',
      tenantId: 'tenant-1',
      organizationId: 'org-1',
      jobType: 'finoo_customer_retention.reconcile',
      status: 'pending',
      processedCount: 0,
      progressPercent: 0,
      totalCount: 400,
      meta: {
        reconciliationGeneration: 9,
        nextAfterCustomerEntityId: null,
        checkpointComplete: false,
      },
    }
    const reconcilePage = jest.fn().mockResolvedValue({
      selected: 200,
      processed: 200,
      changed: 12,
      nextCustomerEntityId: 'person-200',
      reconciliationGeneration: 9,
      staleGeneration: false,
    })
    const transactionEm = {
      findOne: jest.fn().mockResolvedValue(progressJob),
      flush: jest.fn().mockResolvedValue(undefined),
    }
    const rootEm = {
      fork: () => ({
        findOne: jest.fn().mockImplementation(async () => progressJob),
        transactional: async (operation: (em: typeof transactionEm) => Promise<unknown>) =>
          operation(transactionEm),
      }),
    }
    const progressService = {
      startJob: jest.fn().mockImplementation(async () => {
        progressJob.status = 'running'
        return progressJob
      }),
      updateProgress: jest.fn().mockResolvedValue(progressJob),
      completeJob: jest.fn().mockResolvedValue(progressJob),
      failJob: jest.fn(),
    }
    const context = {
      jobId: 'job-duplicate',
      attemptNumber: 1,
      queueName: metadata.queue,
      resolve: (name: string) => {
        if (name === 'em') return rootEm
        if (name === 'progressService') return progressService
        return { reconcilePage }
      },
    }
    const queuedJob = {
      id: 'job-duplicate',
      createdAt: '2026-08-24T12:00:00.000Z',
      payload: {
        tenantId: 'tenant-1',
        organizationId: 'org-1',
        progressJobId: 'progress-1',
        reconciliationGeneration: 9,
      },
    }

    enqueue.mockRejectedValueOnce(new Error('continuation enqueue failed'))
    await expect(handle(queuedJob, context as never)).rejects.toThrow('continuation enqueue failed')
    await handle(queuedJob, context as never)
    await handle(queuedJob, context as never)

    expect(reconcilePage).toHaveBeenCalledTimes(1)
    expect(progressJob.processedCount).toBe(200)
    expect(progressJob.meta.nextAfterCustomerEntityId).toBe('person-200')
    expect(progressService.updateProgress).toHaveBeenCalledTimes(1)
    expect(enqueue).toHaveBeenCalledTimes(2)
  })

  it('marks progress failed only after the final queue attempt', async () => {
    const failure = new Error('projection failed')
    const reconcilePage = jest.fn().mockRejectedValue(failure)
    const failJob = jest.fn()
    const startJob = jest.fn()
    const progressJob = {
      id: 'progress-1',
      status: 'pending',
      meta: { reconciliationGeneration: 1, nextAfterCustomerEntityId: null },
    }
    const resolve = (name: string) => {
      if (name === 'progressService') return { failJob, startJob }
      if (name === 'em') {
        return { fork: () => ({ findOne: jest.fn().mockResolvedValue(progressJob) }) }
      }
      return { reconcilePage }
    }
    const queuedJob = {
      id: 'job-4',
      createdAt: '2026-08-24T12:00:00.000Z',
      payload: {
        tenantId: 'tenant-1',
        organizationId: 'org-1',
        progressJobId: 'progress-1',
      },
    }
    await expect(handle(queuedJob, {
      jobId: 'job-4', attemptNumber: 2, queueName: metadata.queue, resolve,
    } as never)).rejects.toThrow('projection failed')
    expect(failJob).not.toHaveBeenCalled()

    await expect(handle(queuedJob, {
      jobId: 'job-4', attemptNumber: 3, queueName: metadata.queue, resolve,
    } as never)).rejects.toThrow('projection failed')
    expect(failJob).toHaveBeenCalledWith('progress-1', {
      errorMessage: 'Finoo customer retention reconciliation failed',
    }, expect.objectContaining({ tenantId: 'tenant-1', organizationId: 'org-1' }))
  })
})
