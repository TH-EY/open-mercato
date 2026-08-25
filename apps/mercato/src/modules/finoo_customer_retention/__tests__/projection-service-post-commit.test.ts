const emitEvent = jest.fn()
const loggerError = jest.fn()

jest.mock('@open-mercato/shared/lib/logger', () => ({
  createLogger: () => ({ child: () => ({ error: (...args: unknown[]) => loggerError(...args) }) }),
}))

import { runPersonReindexPostCommit } from '../services/projectionService'

describe('FINOO retention projection post-commit effects', () => {
  const scope = {
    tenantId: '5164d495-1865-4738-b459-2783999a761d',
    organizationId: 'd0d98cb3-28cf-4376-a61c-d270020f166f',
  }
  const container = {
    hasRegistration: () => true,
    resolve: () => ({ emitEvent }),
  }

  beforeEach(() => {
    emitEvent.mockReset()
    loggerError.mockReset()
  })

  it('does not report a committed identity erasure as failed when reindexing rejects', async () => {
    emitEvent.mockRejectedValueOnce(new Error('index_failure_canary'))

    await expect(runPersonReindexPostCommit({
      container: container as never,
      scope,
      profileId: '7b622a27-59bf-4b42-9e88-b974fab84fe1',
      customerEntityId: 'ee823a18-e50c-4de4-9d71-4f516d7d754e',
      operationApplied: true,
    })).resolves.toBeUndefined()

    expect(emitEvent).toHaveBeenCalledTimes(1)
    expect(loggerError).toHaveBeenCalledTimes(1)
  })

  it('still reports reindex failures when no irreversible operation was committed', async () => {
    emitEvent.mockRejectedValueOnce(new Error('index_failure_canary'))

    await expect(runPersonReindexPostCommit({
      container: container as never,
      scope,
      profileId: '7b622a27-59bf-4b42-9e88-b974fab84fe1',
      customerEntityId: 'ee823a18-e50c-4de4-9d71-4f516d7d754e',
      operationApplied: false,
    })).rejects.toThrow('index_failure_canary')
  })
})
