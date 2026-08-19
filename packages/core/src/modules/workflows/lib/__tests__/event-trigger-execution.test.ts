jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findWithDecryption: jest.fn(),
}))

jest.mock('../workflow-executor', () => ({
  executeWorkflow: jest.fn(),
  startWorkflow: jest.fn(),
}))

import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { processEventTriggers } from '../event-trigger-service'
import { executeWorkflow, startWorkflow } from '../workflow-executor'

const findWithDecryptionMock = jest.mocked(findWithDecryption)
const executeWorkflowMock = jest.mocked(executeWorkflow)
const startWorkflowMock = jest.mocked(startWorkflow)

describe('event-trigger-service — workflow execution dispatch', () => {
  const tenantId = '00000000-0000-4000-8000-000000000001'
  const organizationId = '00000000-0000-4000-8000-000000000002'

  beforeEach(() => {
    jest.resetAllMocks()
    ;(globalThis as any).__openMercatoWorkflowTriggerCache__?.clear?.()
  })

  it('waits for triggered workflow execution instead of orphaning a running instance', async () => {
    const em = { count: jest.fn() } as any
    const container = { resolve: jest.fn() } as any
    const definition = {
      id: 'definition-1',
      workflowId: 'deal-flow',
      version: 1,
      // Upstream now skips disabled definitions when projecting embedded triggers.
      enabled: true,
      definition: {
        triggers: [
          {
            triggerId: 'deal-created',
            name: 'Deal Created',
            eventPattern: 'customers.deal.created',
            enabled: true,
            priority: 0,
          },
        ],
      },
    }

    // Resolve by entity rather than by call order: the trigger loader issues its
    // queries conditionally, so a positional mock silently starves the definition
    // lookup when the legacy-trigger branch short-circuits.
    findWithDecryptionMock.mockImplementation((async (_em: any, entity: any) =>
      entity?.name === 'WorkflowDefinition' ? [definition] : []) as any)
    startWorkflowMock.mockResolvedValue({ id: 'instance-1' } as any)

    let resolveExecution!: () => void
    executeWorkflowMock.mockImplementation(
      () =>
        new Promise<any>((resolve) => {
          resolveExecution = () => resolve({
            status: 'COMPLETED',
            currentStep: 'end',
            context: {},
            events: [],
            executionTime: 1,
          })
        }),
    )

    let finished = false
    const resultPromise = processEventTriggers(em, container, {
      eventName: 'customers.deal.created',
      payload: { id: 'deal-1' },
      tenantId,
      organizationId,
    }).then((result) => {
      finished = true
      return result
    })

    for (let index = 0; index < 10 && executeWorkflowMock.mock.calls.length === 0; index += 1) {
      await Promise.resolve()
    }

    // The executor also receives the resolved actor (undefined for an unattributed
    // event), so the awaited dispatch carries upstream's actor propagation.
    expect(executeWorkflowMock).toHaveBeenCalledWith(em, container, 'instance-1', undefined)
    expect(startWorkflowMock).toHaveBeenCalledWith(
      em,
      expect.objectContaining({
        metadata: expect.objectContaining({
          entityId: 'deal-1',
          entityType: 'customers.deal',
        }),
      }),
    )
    expect(finished).toBe(false)

    resolveExecution()
    const result = await resultPromise

    expect(finished).toBe(true)
    expect(result.triggered).toBe(1)
    expect(result.instances).toEqual([{ triggerId: 'definition-1:deal-created', instanceId: 'instance-1' }])
  })
})
