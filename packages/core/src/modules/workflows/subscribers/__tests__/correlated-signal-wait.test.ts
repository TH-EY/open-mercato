jest.mock('../../lib/signal-handler', () => ({
  processCorrelatedSignalEvent: jest.fn(),
}))

import { processCorrelatedSignalEvent } from '../../lib/signal-handler'
import handle, { metadata } from '../correlated-signal-wait'

const mockProcess = processCorrelatedSignalEvent as jest.MockedFunction<typeof processCorrelatedSignalEvent>

describe('correlated signal wait subscriber', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockProcess.mockResolvedValue({ matched: 1, resumed: 1, ignored: 0 })
  })

  it('is a persistent wildcard subscriber', () => {
    expect(metadata).toEqual({
      id: 'workflows:correlated-signal-wait',
      event: '*',
      persistent: true,
    })
  })

  it('passes only trusted subscriber metadata as scope', async () => {
    const em = {} as any
    const resolve = jest.fn((name: string) => {
      if (name === 'em') return em
      throw new Error(`Unexpected dependency ${name}`)
    })
    const payload = {
      id: 'task-1',
      tenantId: 'spoofed-tenant',
      organizationId: 'spoofed-org',
    }

    await handle(payload, {
      resolve,
      eventName: 'customers.interaction.completed',
      tenantId: 'trusted-tenant',
      organizationId: 'trusted-org',
    })

    expect(mockProcess).toHaveBeenCalledWith(
      em,
      expect.objectContaining({ resolve }),
      {
        eventName: 'customers.interaction.completed',
        payload,
        tenantId: 'trusted-tenant',
        organizationId: 'trusted-org',
      },
    )
  })

  it.each([
    { eventName: undefined, tenantId: 'tenant', organizationId: 'org' },
    { eventName: 'event', tenantId: undefined, organizationId: 'org' },
    { eventName: 'event', tenantId: 'tenant', organizationId: undefined },
  ])('ignores events without complete trusted metadata: %p', async (ctx) => {
    await handle({ id: 'task-1' }, { resolve: jest.fn(), ...ctx })
    expect(mockProcess).not.toHaveBeenCalled()
  })

  it('does not let a workflow-authored EMIT_EVENT consume a correlated domain wait', async () => {
    await handle({
      id: 'task-1',
      _workflow: {
        workflowInstanceId: 'attacker-workflow-instance',
        workflowId: 'attacker-workflow',
      },
    }, {
      resolve: jest.fn(),
      eventName: 'customers.interaction.completed',
      tenantId: 'tenant',
      organizationId: 'org',
    })

    expect(mockProcess).not.toHaveBeenCalled()
  })

  it('propagates delivery failures so the persistent event can retry', async () => {
    mockProcess.mockRejectedValueOnce(new Error('delivery failed'))

    await expect(handle({ id: 'task-1' }, {
      resolve: jest.fn(() => ({})),
      eventName: 'customers.interaction.completed',
      tenantId: 'tenant',
      organizationId: 'org',
    })).rejects.toThrow('delivery failed')
  })
})
