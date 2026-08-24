const invalidateCrudCache = jest.fn()
const emitFinooIdentityEvent = jest.fn()
const loggerError = jest.fn()

jest.mock('@open-mercato/shared/lib/crud/cache', () => ({
  invalidateCrudCache: (...args: unknown[]) => invalidateCrudCache(...args),
}))

jest.mock('@open-mercato/shared/lib/logger', () => ({
  createLogger: () => ({ child: () => ({ error: (...args: unknown[]) => loggerError(...args) }) }),
}))

jest.mock('../events', () => ({
  emitFinooIdentityEvent: (...args: unknown[]) => emitFinooIdentityEvent(...args),
}))

import { runFinooIdentityPostCommitEffects } from '../di'

describe('FINOO identity post-commit effects', () => {
  beforeEach(() => {
    invalidateCrudCache.mockReset()
    emitFinooIdentityEvent.mockReset()
    loggerError.mockReset()
  })

  it('does not reject a committed mutation when cache and event effects fail', async () => {
    invalidateCrudCache.mockRejectedValue(new Error('cache_failure_canary'))
    emitFinooIdentityEvent.mockRejectedValue(new Error('event_failure_canary'))

    await expect(runFinooIdentityPostCommitEffects({} as never, {
      eventId: 'finoo_identities.identity.updated',
      tenantId: '5164d495-1865-4738-b459-2783999a761d',
      organizationId: 'd0d98cb3-28cf-4376-a61c-d270020f166f',
      personId: 'ee823a18-e50c-4de4-9d71-4f516d7d754e',
      identityId: 'a9066128-71b3-462b-97cc-47f6cc104a9d',
      changedFields: ['documentNumber'],
      isComplete: true,
    })).resolves.toBeUndefined()

    expect(invalidateCrudCache).toHaveBeenCalledTimes(1)
    expect(emitFinooIdentityEvent).toHaveBeenCalledTimes(1)
    expect(loggerError).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(loggerError.mock.calls)).not.toContain('documentNumberValue')
  })
})
