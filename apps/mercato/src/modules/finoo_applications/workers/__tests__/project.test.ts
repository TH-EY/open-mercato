const project = jest.fn()
const flush = jest.fn(async () => undefined)
const execute = jest.fn(async () => [{ attempt_count: 1 }])
const nativeUpdate = jest.fn(async () => 1)
const intake = {
  id: 'intake-1', tenantId: 'tenant-1', organizationId: 'org-1',
  externalLeadId: 'lead-1',
  state: 'pending', attemptCount: 0, lastErrorCode: null, nextAttemptAt: null, leaseExpiresAt: null, processedAt: null,
}

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: async () => ({
    resolve: (name: string) => {
      if (name === 'em') return { fork: () => ({ flush, nativeUpdate, getConnection: () => ({ execute }) }) }
      if (name === 'commandBus') return {}
      throw new Error(`unexpected ${name}`)
    },
  }),
}))
jest.mock('@open-mercato/shared/lib/encryption/find', () => ({ findOneWithDecryption: async () => intake }))
jest.mock('../../lib/projector', () => ({
  projectFinooApplication: (...args: unknown[]) => project(...args),
  safeProjectionErrorCode: () => 'projection_failed',
}))

import handle from '../project'
import { FINOO_APPLICATION_MAX_ATTEMPTS } from '../../lib/queue'

describe('FINOO projection worker retry state', () => {
  beforeEach(() => {
    project.mockReset()
    flush.mockClear()
    nativeUpdate.mockClear()
    execute.mockReset().mockResolvedValue([{ attempt_count: 1 }])
    Object.assign(intake, { state: 'pending', attemptCount: 0, lastErrorCode: null, nextAttemptAt: null, leaseExpiresAt: null, processedAt: null })
  })

  it('marks an earlier failure retrying and rethrows', async () => {
    project.mockRejectedValueOnce(new Error('transient'))
    await expect(handle({ payload: { intakeId: 'intake-1', tenantId: 'tenant-1', organizationId: 'org-1' } } as never, { attemptNumber: 1 } as never)).rejects.toThrow('transient')
    expect(intake.state).toBe('retrying')
    expect(intake.lastErrorCode).toBe('projection_failed')
    expect(intake.nextAttemptAt).toBeInstanceOf(Date)
    expect(nativeUpdate).toHaveBeenCalledWith(expect.anything(), {
      tenantId: 'tenant-1',
      organizationId: 'org-1',
      externalLeadId: 'lead-1',
    }, { lastErrorCode: 'projection_failed' })
  })

  it('marks only an exhausted failure terminal', async () => {
    execute.mockResolvedValueOnce([{ attempt_count: FINOO_APPLICATION_MAX_ATTEMPTS }])
    project.mockRejectedValueOnce(new Error('terminal'))
    await expect(handle({ payload: { intakeId: 'intake-1', tenantId: 'tenant-1', organizationId: 'org-1' } } as never, { attemptNumber: FINOO_APPLICATION_MAX_ATTEMPTS } as never)).rejects.toThrow('terminal')
    expect(intake.state).toBe('failed')
    expect(intake.nextAttemptAt).toBeNull()
  })

  it('uses the durable intake attempt count instead of the queue job attempt', async () => {
    execute.mockResolvedValueOnce([{ attempt_count: FINOO_APPLICATION_MAX_ATTEMPTS }])
    project.mockRejectedValueOnce(new Error('terminal'))
    await expect(handle({ payload: { intakeId: 'intake-1', tenantId: 'tenant-1', organizationId: 'org-1' } } as never, { attemptNumber: 1 } as never)).rejects.toThrow('terminal')
    expect(intake.state).toBe('failed')
    expect(intake.attemptCount).toBe(FINOO_APPLICATION_MAX_ATTEMPTS)
  })

  it('keeps an expiring dispatch lease so a crashed worker can be reconciled', async () => {
    project.mockResolvedValueOnce({})
    await handle({ payload: { intakeId: 'intake-1', tenantId: 'tenant-1', organizationId: 'org-1' } } as never, { attemptNumber: 1 } as never)
    expect(execute.mock.calls[0]?.[0]).toContain('dispatch_lease_expires_at = ?')
    expect(execute.mock.calls[0]?.[1]?.[0]).toBeInstanceOf(Date)
    expect(execute.mock.calls[0]?.[1]?.[1]).toEqual(execute.mock.calls[0]?.[1]?.[0])
  })

  it('marks successful projection processed', async () => {
    project.mockResolvedValueOnce({})
    await handle({ payload: { intakeId: 'intake-1', tenantId: 'tenant-1', organizationId: 'org-1' } } as never, { attemptNumber: 1 } as never)
    expect(intake.state).toBe('processed')
    expect(intake.processedAt).toBeInstanceOf(Date)
  })
})
