const enqueue = jest.fn(async () => 'job-1')

jest.mock('../queue', () => ({ getFinooApplicationQueue: () => ({ enqueue }) }))

import { dispatchFinooApplicationIntake } from '../dispatch'

const job = { intakeId: 'intake-1', tenantId: 'tenant-1', organizationId: 'org-1' }

describe('FINOO intake dispatch lease', () => {
  beforeEach(() => enqueue.mockReset().mockResolvedValue('job-1'))

  it('does not enqueue when another dispatcher owns the lease', async () => {
    const execute = jest.fn(async () => [])
    await expect(dispatchFinooApplicationIntake({ getConnection: () => ({ execute }) } as never, job)).resolves.toBe(false)
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('marks a successful enqueue and prevents normal reconciliation amplification', async () => {
    const execute = jest.fn()
      .mockResolvedValueOnce([{ id: job.intakeId }])
      .mockResolvedValueOnce([])
    await expect(dispatchFinooApplicationIntake({ getConnection: () => ({ execute }) } as never, job)).resolves.toBe(true)
    expect(enqueue).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[1]?.[0]).toContain("dispatch_state = 'enqueued'")
  })

  it('returns the durable outbox to pending when enqueue fails', async () => {
    enqueue.mockRejectedValueOnce(new Error('queue unavailable'))
    const execute = jest.fn()
      .mockResolvedValueOnce([{ id: job.intakeId }])
      .mockResolvedValueOnce([])
    await expect(dispatchFinooApplicationIntake({ getConnection: () => ({ execute }) } as never, job)).resolves.toBe(false)
    expect(execute.mock.calls[1]?.[0]).toContain("dispatch_state = 'pending'")
  })
})
