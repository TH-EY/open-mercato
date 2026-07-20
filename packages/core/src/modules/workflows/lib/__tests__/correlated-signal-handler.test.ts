import { LockMode } from '@mikro-orm/core'
import {
  StepInstance,
  WorkflowBranchInstance,
  WorkflowDefinition,
  WorkflowInstance,
} from '../../data/entities'
import { processCorrelatedSignalEvent } from '../signal-handler'

describe('correlated signal delivery', () => {
  const tenantId = 'tenant-1'
  const organizationId = 'org-1'
  const eventName = 'customers.interaction.completed'

  function createHarness(options: {
    branch?: boolean
    valid?: boolean
    transitionSuccess?: boolean
    continuationSuccess?: boolean
    continuationStatus?: 'RUNNING' | 'FAILED'
  } = {}) {
    const instance = {
      id: 'instance-1',
      definitionId: 'definition-1',
      currentStepId: options.branch ? 'fork' : 'wait-for-task',
      status: options.branch ? 'FORKED' : 'PAUSED',
      activeForkStepId: options.branch ? 'fork' : null,
      context: {},
      tenantId,
      organizationId,
    } as WorkflowInstance
    const branch = options.branch ? {
      id: 'branch-1',
      workflowInstanceId: instance.id,
      currentStepId: 'wait-for-task',
      status: 'PAUSED',
      contextNamespace: {},
      tenantId,
      organizationId,
    } as WorkflowBranchInstance : null
    const step = {
      id: 'step-instance-1',
      workflowInstanceId: instance.id,
      branchInstanceId: branch?.id ?? null,
      stepId: 'wait-for-task',
      stepType: 'WAIT_FOR_SIGNAL',
      status: 'ACTIVE',
      waitSignalName: eventName,
      waitCorrelationKey: 'task-1',
      waitPayloadPath: 'id',
      tenantId,
      organizationId,
    } as StepInstance
    const definition = {
      id: instance.definitionId,
      definition: {
        steps: [],
        transitions: [
          { transitionId: 'resume', fromStepId: step.stepId, toStepId: 'end', trigger: 'auto' },
        ],
      },
      tenantId,
      organizationId,
    } as WorkflowDefinition

    const findOne = jest.fn(async (entity: unknown, criteria: any, queryOptions?: any) => {
      if (entity === WorkflowInstance) return instance
      if (entity === StepInstance) return step.status === 'ACTIVE' ? step : null
      if (entity === WorkflowBranchInstance) return branch
      if (entity === WorkflowDefinition) return definition
      return null
    })
    const em = {
      createQueryBuilder: jest.fn(() => ({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue([{ waitPayloadPath: step.waitPayloadPath }]),
      })),
      find: jest.fn(async (_entity: unknown, criteria: any) => {
        return step.status === 'ACTIVE' && criteria.waitCorrelationKey === step.waitCorrelationKey
          ? [step]
          : []
      }),
      findOne,
      flush: jest.fn().mockResolvedValue(undefined),
      transactional: jest.fn(async (work: (tx: any) => Promise<unknown>) => work(em)),
    } as any

    const logWorkflowEvent = jest.fn().mockResolvedValue(undefined)
    const exitStep = jest.fn(async (_em, activeStep: StepInstance) => {
      activeStep.status = 'COMPLETED'
    })
    const findValidTransitions = jest.fn().mockResolvedValue([
      {
        isValid: options.valid ?? true,
        transition: definition.definition.transitions[0],
      },
    ])
    const executeTransitionForToken = jest.fn(async (_em, _container, token) => {
      if (options.transitionSuccess === false) return { success: false, error: 'failed' }
      if (token.kind === 'branch') token.branch.currentStepId = 'end'
      else token.instance.currentStepId = 'end'
      return { success: true, nextStepId: 'end' }
    })
    const executeWorkflow = options.continuationSuccess === false
      ? jest.fn().mockRejectedValue(new Error('automatic continuation failed'))
      : jest.fn().mockResolvedValue({ status: options.continuationStatus ?? 'RUNNING' })
    const container = {
      resolve: jest.fn((name: string) => {
        if (name === 'eventLogger') return { logWorkflowEvent }
        if (name === 'stepHandler') return { exitStep }
        if (name === 'transitionHandler') return { findValidTransitions, executeTransitionForToken }
        if (name === 'workflowExecutor') return { executeWorkflow }
        throw new Error(`Unexpected dependency: ${name}`)
      }),
    } as any

    return {
      instance,
      branch,
      step,
      em,
      container,
      logWorkflowEvent,
      exitStep,
      findValidTransitions,
      executeTransitionForToken,
      executeWorkflow,
    }
  }

  it('resumes the exact scoped root wait and becomes idempotent', async () => {
    const h = createHarness()

    const first = await processCorrelatedSignalEvent(h.em, h.container, {
      eventName,
      payload: { id: 'task-1' },
      tenantId,
      organizationId,
    })
    const duplicate = await processCorrelatedSignalEvent(h.em, h.container, {
      eventName,
      payload: { id: 'task-1' },
      tenantId,
      organizationId,
    })

    expect(first).toEqual({ matched: 1, resumed: 1, ignored: 0 })
    expect(duplicate).toEqual({ matched: 0, resumed: 0, ignored: 0 })
    expect(h.step.status).toBe('COMPLETED')
    expect(h.instance.context).toMatchObject({
      signals: {
        'wait-for-task': {
          name: eventName,
          payload: { id: 'task-1' },
          receivedAt: expect.any(String),
        },
      },
    })
    expect(h.executeTransitionForToken).toHaveBeenCalledTimes(1)
    expect(h.executeWorkflow).toHaveBeenCalledTimes(1)
    expect(h.executeWorkflow).toHaveBeenCalledWith(
      h.em,
      h.container,
      h.instance.id,
      { rollbackOnFailure: true },
    )
    expect(h.em.createQueryBuilder).toHaveBeenCalledWith(StepInstance, 'wait')
    expect(h.em.find).toHaveBeenCalledWith(
      StepInstance,
      expect.objectContaining({
        waitPayloadPath: 'id',
        waitCorrelationKey: 'task-1',
      }),
    )
    expect(h.em.findOne).toHaveBeenCalledWith(
      WorkflowInstance,
      expect.objectContaining({ id: h.instance.id, tenantId, organizationId }),
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    )
  })

  it('ignores the wrong payload value before opening a transaction', async () => {
    const h = createHarness()

    const result = await processCorrelatedSignalEvent(h.em, h.container, {
      eventName,
      payload: { id: 'different-task' },
      tenantId,
      organizationId,
    })

    expect(result).toEqual({ matched: 0, resumed: 0, ignored: 0 })
    expect(h.em.transactional).not.toHaveBeenCalled()
  })

  it('keeps a routing match active when transition conditions reject it', async () => {
    const h = createHarness({ valid: false })

    const result = await processCorrelatedSignalEvent(h.em, h.container, {
      eventName,
      payload: { id: 'task-1' },
      tenantId,
      organizationId,
    })

    expect(result).toEqual({ matched: 1, resumed: 0, ignored: 1 })
    expect(h.step.status).toBe('ACTIVE')
    expect(h.instance.status).toBe('PAUSED')
    expect(h.exitStep).not.toHaveBeenCalled()
    expect(h.logWorkflowEvent).toHaveBeenCalledWith(
      h.em,
      expect.objectContaining({
        eventType: 'SIGNAL_IGNORED',
        stepInstanceId: h.step.id,
      }),
    )
  })

  it('resumes only the exact parallel branch token', async () => {
    const h = createHarness({ branch: true })

    const result = await processCorrelatedSignalEvent(h.em, h.container, {
      eventName,
      payload: { id: 'task-1' },
      tenantId,
      organizationId,
    })

    expect(result.resumed).toBe(1)
    expect(h.instance.status).toBe('FORKED')
    expect(h.branch?.status).toBe('ACTIVE')
    expect(h.executeTransitionForToken).toHaveBeenCalledWith(
      h.em,
      h.container,
      expect.objectContaining({ kind: 'branch', branch: h.branch }),
      'wait-for-task',
      'end',
      expect.any(Object),
      'resume',
    )
  })

  it('rolls back consumption when the selected transition fails', async () => {
    const h = createHarness({ transitionSuccess: false })
    const original = {
      stepStatus: h.step.status,
      instanceStatus: h.instance.status,
      context: h.instance.context,
    }
    h.em.transactional.mockImplementation(async (work: (tx: any) => Promise<unknown>) => {
      try {
        return await work(h.em)
      } catch (error) {
        h.step.status = original.stepStatus
        h.instance.status = original.instanceStatus
        h.instance.context = original.context
        throw error
      }
    })

    await expect(processCorrelatedSignalEvent(h.em, h.container, {
      eventName,
      payload: { id: 'task-1' },
      tenantId,
      organizationId,
    })).rejects.toThrow(/transition failed/i)

    expect(h.step.status).toBe('ACTIVE')
    expect(h.instance.status).toBe('PAUSED')
    expect(h.executeWorkflow).not.toHaveBeenCalled()
  })

  it('keeps the entered destination durable when later automatic continuation fails', async () => {
    const h = createHarness({ continuationSuccess: false })

    await expect(processCorrelatedSignalEvent(h.em, h.container, {
      eventName,
      payload: { id: 'task-1' },
      tenantId,
      organizationId,
    })).rejects.toThrow(/correlated signal transition failed/i)

    expect(h.step.status).toBe('COMPLETED')
    expect(h.instance.currentStepId).toBe('end')
    expect(h.instance.status).toBe('FAILED')
    expect(h.instance.errorDetails).toEqual(expect.objectContaining({
      code: 'CORRELATED_SIGNAL_CONTINUATION_FAILED',
      resumeStatus: 'RUNNING',
    }))
    expect(h.instance.context).toMatchObject({
      signals: {
        'wait-for-task': expect.objectContaining({ payload: { id: 'task-1' } }),
      },
    })
    expect(h.executeTransitionForToken).toHaveBeenCalledTimes(1)
    expect(h.executeWorkflow).toHaveBeenCalledTimes(1)
  })

  it('marks a failed branch continuation as retryable from the durable branch cursor', async () => {
    const h = createHarness({ branch: true, continuationSuccess: false })

    await expect(processCorrelatedSignalEvent(h.em, h.container, {
      eventName,
      payload: { id: 'task-1' },
      tenantId,
      organizationId,
    })).rejects.toThrow(/correlated signal transition failed/i)

    expect(h.step.status).toBe('COMPLETED')
    expect(h.branch?.currentStepId).toBe('end')
    expect(h.branch?.status).toBe('ACTIVE')
    expect(h.instance.status).toBe('FAILED')
    expect(h.instance.errorDetails).toEqual(expect.objectContaining({
      code: 'CORRELATED_SIGNAL_CONTINUATION_FAILED',
      resumeStatus: 'FORKED',
      branchInstanceId: h.branch?.id,
    }))
  })

  it('treats a resolved FAILED continuation result as a recoverable delivery failure', async () => {
    const h = createHarness({ branch: true, continuationStatus: 'FAILED' })

    await expect(processCorrelatedSignalEvent(h.em, h.container, {
      eventName,
      payload: { id: 'task-1' },
      tenantId,
      organizationId,
    })).rejects.toThrow(/correlated signal transition failed/i)

    expect(h.instance.status).toBe('FAILED')
    expect(h.instance.errorDetails).toEqual(expect.objectContaining({
      code: 'CORRELATED_SIGNAL_CONTINUATION_FAILED',
      resumeStatus: 'FORKED',
    }))
  })
})
