/**
 * Signal Handler Service
 *
 * Receives external signals and resumes workflows waiting for them.
 */

import { EntityManager, LockMode } from '@mikro-orm/core'
import type { EntityManager as PostgreSqlEntityManager } from '@mikro-orm/postgresql'
import type { AwilixContainer } from 'awilix'
import { findOneWithDecryption, findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { WorkflowInstance, WorkflowBranchInstance, WorkflowDefinition, StepInstance } from '../data/entities'
import type * as eventLoggerModule from './event-logger'
import type * as stepHandlerModule from './step-handler'
import type * as transitionHandlerModule from './transition-handler'
import type * as workflowExecutorModule from './workflow-executor'
import { branchToken, mergeTokenContext, rootToken, tokenReadContext } from './execution-token'
import { readCorrelationScalar } from './signal-correlation'

export interface SendSignalOptions {
  /**
   * Workflow instance ID
   */
  instanceId: string

  /**
   * Signal name to match against WAIT_FOR_SIGNAL step config
   */
  signalName: string

  /**
   * Optional payload to merge into workflow context
   */
  payload?: Record<string, any>

  /**
   * User ID sending the signal
   */
  userId?: string

  /**
   * Tenant/org scope
   */
  tenantId: string
  organizationId: string
}

export class SignalError extends Error {
  constructor(
    message: string,
    public code: string,
    public details?: any
  ) {
    super(message)
    this.name = 'SignalError'
  }
}

export interface CorrelatedSignalEventOptions {
  eventName: string
  payload: Record<string, unknown>
  tenantId: string
  organizationId: string
}

export interface CorrelatedSignalEventResult {
  matched: number
  resumed: number
  ignored: number
}

const CORRELATED_CONTINUATION_FAILURE = 'CORRELATED_SIGNAL_CONTINUATION_FAILED'

async function markCorrelatedContinuationFailed(
  em: EntityManager,
  container: AwilixContainer,
  instanceId: string,
  branchInstanceId: string | null | undefined,
  tenantId: string,
  organizationId: string,
  error: unknown,
): Promise<void> {
  const errorMessage = error instanceof Error ? error.message : String(error)
  await em.transactional(async (tx) => {
    const instance = await tx.findOne(WorkflowInstance, {
      id: instanceId,
      tenantId,
      organizationId,
    }, { lockMode: LockMode.PESSIMISTIC_WRITE })
    if (!instance || instance.status === 'COMPLETED' || instance.status === 'CANCELLED') return

    const resumeStatus = branchInstanceId ? 'FORKED' : 'RUNNING'
    instance.status = 'FAILED'
    instance.errorMessage = errorMessage
    instance.errorDetails = {
      code: CORRELATED_CONTINUATION_FAILURE,
      resumeStatus,
      branchInstanceId: branchInstanceId ?? null,
    }
    instance.updatedAt = new Date()
    await tx.flush()

    const eventLogger = container.resolve<typeof eventLoggerModule>('eventLogger')
    await eventLogger.logWorkflowEvent(tx, {
      workflowInstanceId: instance.id,
      branchInstanceId: branchInstanceId ?? undefined,
      eventType: 'WORKFLOW_FAILED',
      eventData: {
        code: CORRELATED_CONTINUATION_FAILURE,
        error: errorMessage,
        resumeStatus,
      },
      tenantId,
      organizationId,
    })
  })
}

/**
 * Send signal to workflow instance and resume execution
 */
export async function sendSignal(
  em: EntityManager,
  container: AwilixContainer,
  options: SendSignalOptions
): Promise<void> {
  const { instanceId, signalName, payload, userId, tenantId, organizationId } = options

  const eventLogger = container.resolve<typeof eventLoggerModule>('eventLogger')
  const stepHandler = container.resolve<typeof stepHandlerModule>('stepHandler')
  const transitionHandler = container.resolve<typeof transitionHandlerModule>('transitionHandler')
  const workflowExecutor = container.resolve<typeof workflowExecutorModule>('workflowExecutor')

  // Fetch workflow instance
  const instance = await findOneWithDecryption(
    em as PostgreSqlEntityManager,
    WorkflowInstance,
    {
      id: instanceId,
      tenantId,
      organizationId,
    },
    undefined,
    { tenantId, organizationId },
  )

  if (!instance) {
    throw new SignalError(
      'Workflow instance not found',
      'INSTANCE_NOT_FOUND',
      { instanceId }
    )
  }

  // Branch-scoped signal: a FORKED instance routes the signal to the branch
  // paused at a matching WAIT_FOR_SIGNAL step.
  if (instance.status === 'FORKED') {
    const branchDefinition = await findOneWithDecryption(
      em as PostgreSqlEntityManager,
      WorkflowDefinition,
      { id: instance.definitionId, tenantId: instance.tenantId, organizationId: instance.organizationId, deletedAt: null },
      undefined,
      { tenantId: instance.tenantId, organizationId: instance.organizationId },
    )
    if (!branchDefinition) {
      throw new SignalError('Workflow definition not found', 'DEFINITION_NOT_FOUND', { definitionId: instance.definitionId })
    }

    const pausedBranches = await em.find(WorkflowBranchInstance, {
      workflowInstanceId: instanceId,
      status: 'PAUSED',
      tenantId,
      organizationId,
    })

    let targetBranch: WorkflowBranchInstance | null = null
    for (const candidate of pausedBranches) {
      const step = branchDefinition.definition.steps.find((s: any) => s.stepId === candidate.currentStepId)
      if (step?.stepType === 'WAIT_FOR_SIGNAL') {
        const candidateSignal = step.signalConfig?.signalName || step.stepId
        if (candidateSignal === signalName) {
          targetBranch = candidate
          break
        }
      }
    }

    if (!targetBranch) {
      throw new SignalError('No parallel branch awaiting this signal', 'NO_BRANCH_AWAITING_SIGNAL', { instanceId, signalName })
    }

    const branchStepInstance = await em.findOne(StepInstance, {
      workflowInstanceId: instanceId,
      branchInstanceId: targetBranch.id,
      stepId: targetBranch.currentStepId,
      status: 'ACTIVE',
    })

    const now = new Date()
    const contextMerge = payload
      ? {
          ...payload,
          [`signal_${signalName}_payload`]: payload,
          [`signal_${signalName}_receivedAt`]: now.toISOString(),
        }
      : {}
    const candidateContext = {
      ...(instance.context || {}),
      ...(targetBranch.contextNamespace || {}),
      ...contextMerge,
    }
    const validTransitions = await transitionHandler.findValidTransitions(
      em,
      instance,
      targetBranch.currentStepId,
      { workflowContext: candidateContext, userId },
    )
    const selected = validTransitions.find(
      (entry) => entry.isValid && entry.transition?.trigger === 'auto',
    )

    if (!selected?.transition) {
      await eventLogger.logWorkflowEvent(em, {
        workflowInstanceId: instanceId,
        stepInstanceId: branchStepInstance?.id,
        branchInstanceId: targetBranch.id,
        eventType: 'SIGNAL_IGNORED',
        eventData: { signalName, branch: true, reason: 'NO_VALID_AUTOMATIC_TRANSITION' },
        userId,
        tenantId,
        organizationId,
      })
      return
    }

    await eventLogger.logWorkflowEvent(em, {
      workflowInstanceId: instanceId,
      stepInstanceId: branchStepInstance?.id,
      branchInstanceId: targetBranch.id,
      eventType: 'SIGNAL_RECEIVED',
      eventData: { signalName, payload, branch: true },
      userId,
      tenantId,
      organizationId,
    })

    const { resumeBranch } = await import('./parallel-handler')
    const resumed = await resumeBranch(em, {
      instanceId,
      branchInstanceId: targetBranch.id,
      tenantId,
      organizationId,
      contextMerge,
      exitStepInstanceId: branchStepInstance?.id ?? null,
      exitOutput: { signalName, payload },
    })
    if (resumed) {
      await workflowExecutor.executeWorkflow(em, container, instanceId, { userId })
    }
    return
  }

  // Verify workflow is paused
  if (instance.status !== 'PAUSED') {
    throw new SignalError(
      'Workflow is not paused',
      'WORKFLOW_NOT_PAUSED',
      { instanceId, status: instance.status }
    )
  }

  // Load workflow definition with tenant/org scope to check current step
  const definition = await findOneWithDecryption(
    em as PostgreSqlEntityManager,
    WorkflowDefinition,
    {
      id: instance.definitionId,
      tenantId: instance.tenantId,
      organizationId: instance.organizationId,
      deletedAt: null,
    },
    undefined,
    { tenantId: instance.tenantId, organizationId: instance.organizationId },
  )
  if (!definition) {
    throw new SignalError(
      'Workflow definition not found',
      'DEFINITION_NOT_FOUND',
      { definitionId: instance.definitionId }
    )
  }

  // Find current step
  const currentStep = definition.definition.steps.find(
    (s: any) => s.stepId === instance.currentStepId
  )

  if (!currentStep || currentStep.stepType !== 'WAIT_FOR_SIGNAL') {
    throw new SignalError(
      'Workflow is not waiting for signal',
      'NOT_WAITING_FOR_SIGNAL',
      { instanceId, currentStepId: instance.currentStepId }
    )
  }

  // Check signal name matches
  const expectedSignalName = currentStep.signalConfig?.signalName || currentStep.stepId
  if (expectedSignalName !== signalName) {
    throw new SignalError(
      'Signal name mismatch',
      'SIGNAL_NAME_MISMATCH',
      { expected: expectedSignalName, received: signalName }
    )
  }

  const now = new Date()

  // Build the candidate context first. A signal is consumed only after an
  // outgoing automatic transition accepts this candidate context.
  let candidateContext = instance.context
  if (payload) {
    candidateContext = {
      ...instance.context,
      ...payload,
      [`signal_${signalName}_payload`]: payload,
      [`signal_${signalName}_receivedAt`]: now.toISOString(),
    }
  }

  // Find automatic transitions from current step
  const autoTransitions = (definition.definition.transitions || []).filter(
    (t: any) => t.fromStepId === instance.currentStepId && t.trigger === 'auto'
  )

  if (autoTransitions.length === 0) {
    await eventLogger.logWorkflowEvent(em, {
      workflowInstanceId: instance.id,
      eventType: 'SIGNAL_IGNORED',
      eventData: { signalName, reason: 'NO_AUTOMATIC_TRANSITION' },
      userId,
      tenantId: instance.tenantId,
      organizationId: instance.organizationId,
    })
    return
  }

  // Find valid transitions
  const transitionContext = {
    workflowContext: candidateContext,
    userId,
  }

  const validTransitions = await transitionHandler.findValidTransitions(
    em,
    instance,
    instance.currentStepId,
    transitionContext
  )

  const firstValidTransition = validTransitions.find(
    (result) => result.isValid && result.transition?.trigger === 'auto',
  )

  if (!firstValidTransition || !firstValidTransition.transition) {
    await eventLogger.logWorkflowEvent(em, {
      workflowInstanceId: instance.id,
      eventType: 'SIGNAL_IGNORED',
      eventData: { signalName, reason: 'NO_VALID_AUTOMATIC_TRANSITION' },
      userId,
      tenantId: instance.tenantId,
      organizationId: instance.organizationId,
    })
    return
  }

  instance.context = candidateContext
  instance.status = 'RUNNING'
  instance.updatedAt = now

  await eventLogger.logWorkflowEvent(em, {
    workflowInstanceId: instance.id,
    eventType: 'SIGNAL_RECEIVED',
    eventData: { signalName, payload },
    userId,
    tenantId: instance.tenantId,
    organizationId: instance.organizationId,
  })

  const stepInstance = await findOneWithDecryption(
    em as PostgreSqlEntityManager,
    StepInstance,
    {
      workflowInstanceId: instance.id,
      stepId: instance.currentStepId,
      status: 'ACTIVE',
      tenantId: instance.tenantId,
      organizationId: instance.organizationId,
    },
    undefined,
    { tenantId: instance.tenantId, organizationId: instance.organizationId },
  )

  if (stepInstance) {
    await stepHandler.exitStep(em, stepInstance, { signalName, payload })
  }

  // Execute transition to next step
  const transitionResult = await transitionHandler.executeTransition(
    em,
    container,
    instance,
    instance.currentStepId,
    firstValidTransition.transition.toStepId,
    transitionContext,
    firstValidTransition.transition.transitionId,
  )

  if (!transitionResult.success) {
    throw new SignalError(
      'Transition failed after signal',
      'TRANSITION_FAILED',
      { error: transitionResult.error }
    )
  }

  // Resume workflow execution
  await workflowExecutor.executeWorkflow(em, container, instance.id, { userId })
}

/**
 * Send signal by correlation key (finds all waiting instances)
 */
export async function sendSignalByCorrelationKey(
  em: EntityManager,
  container: AwilixContainer,
  options: Omit<SendSignalOptions, 'instanceId'> & { correlationKey: string }
): Promise<number> {
  const { correlationKey, signalName, payload, userId, tenantId, organizationId } = options

  // Find all paused instances with this correlation key
  const instances = await findWithDecryption(
    em as PostgreSqlEntityManager,
    WorkflowInstance,
    {
      correlationKey,
      status: 'PAUSED',
      tenantId,
      organizationId,
    },
    undefined,
    { tenantId, organizationId },
  )

  let signalsProcessed = 0

  for (const instance of instances) {
    try {
      await sendSignal(em, container, {
        instanceId: instance.id,
        signalName,
        payload,
        userId,
        tenantId,
        organizationId,
      })
      signalsProcessed++
    } catch (error) {
      // Log error but continue processing other instances
      console.error(`Failed to send signal to instance ${instance.id}:`, error)
    }
  }

  return signalsProcessed
}

export async function processCorrelatedSignalEvent(
  em: EntityManager,
  container: AwilixContainer,
  options: CorrelatedSignalEventOptions,
): Promise<CorrelatedSignalEventResult> {
  const { eventName, payload, tenantId, organizationId } = options
  const routingRows: Array<{ waitPayloadPath?: string; wait_payload_path?: string }> = await (em as PostgreSqlEntityManager)
    .createQueryBuilder(StepInstance, 'wait')
    .select('wait.waitPayloadPath')
    .where({
      status: 'ACTIVE',
      waitSignalName: eventName,
      waitPayloadPath: { $ne: null },
      tenantId,
      organizationId,
    })
    .groupBy('wait.waitPayloadPath')
    .execute('all')
  const payloadPaths = new Set<string>(
    routingRows
      .map((row: { waitPayloadPath?: string; wait_payload_path?: string }) => row.waitPayloadPath ?? row.wait_payload_path)
      .filter((path): path is string => typeof path === 'string' && path.length > 0),
  )
  const exactCandidates: StepInstance[] = []
  for (const waitPayloadPath of payloadPaths) {
    const observedKey = readCorrelationScalar(payload, waitPayloadPath)
    if (observedKey == null) continue
    const matches = await em.find(StepInstance, {
      status: 'ACTIVE',
      waitSignalName: eventName,
      waitPayloadPath,
      waitCorrelationKey: observedKey,
      tenantId,
      organizationId,
    })
    exactCandidates.push(...matches)
  }

  const result: CorrelatedSignalEventResult = {
    matched: exactCandidates.length,
    resumed: 0,
    ignored: 0,
  }
  const errors: Array<{ stepInstanceId: string; error: string }> = []

  for (const candidate of exactCandidates) {
    try {
      const outcome = await em.transactional(async (tx) => {
        // Follow the executor's lock order: workflow instance, active wait,
        // then the optional branch row.
        const instance = await tx.findOne(WorkflowInstance, {
          id: candidate.workflowInstanceId,
          tenantId,
          organizationId,
        }, { lockMode: LockMode.PESSIMISTIC_WRITE })
        if (!instance) return 'stale' as const

        const activeStep = await tx.findOne(StepInstance, {
          id: candidate.id,
          workflowInstanceId: instance.id,
          status: 'ACTIVE',
          waitSignalName: eventName,
          waitCorrelationKey: candidate.waitCorrelationKey,
          waitPayloadPath: candidate.waitPayloadPath,
          tenantId,
          organizationId,
        }, { lockMode: LockMode.PESSIMISTIC_WRITE })
        if (!activeStep) return 'stale' as const

        const observedKey = readCorrelationScalar(payload, activeStep.waitPayloadPath!)
        if (observedKey !== activeStep.waitCorrelationKey) return 'stale' as const

        let token = rootToken(instance)
        if (activeStep.branchInstanceId) {
          const branch = await tx.findOne(WorkflowBranchInstance, {
            id: activeStep.branchInstanceId,
            workflowInstanceId: instance.id,
            currentStepId: activeStep.stepId,
            status: 'PAUSED',
            tenantId,
            organizationId,
          }, { lockMode: LockMode.PESSIMISTIC_WRITE })
          if (!branch || instance.status !== 'FORKED') return 'stale' as const
          token = branchToken(instance, branch)
        } else if (instance.status !== 'PAUSED' || instance.currentStepId !== activeStep.stepId) {
          return 'stale' as const
        }

        const receivedAt = new Date().toISOString()
        const currentContext = tokenReadContext(token)
        const currentSignals = currentContext.signals
        const signalContext = {
          ...(currentSignals && typeof currentSignals === 'object' && !Array.isArray(currentSignals)
            ? currentSignals
            : {}),
          [activeStep.stepId]: {
            name: eventName,
            payload,
            receivedAt,
          },
        }
        const candidateContext = { ...currentContext, signals: signalContext }
        const transitionContext = { workflowContext: candidateContext }

        const transitionHandler = container.resolve<typeof transitionHandlerModule>('transitionHandler')
        const validTransitions = await transitionHandler.findValidTransitions(
          tx,
          instance,
          activeStep.stepId,
          transitionContext,
        )
        const selected = validTransitions.find(
          (entry) => entry.isValid && entry.transition?.trigger === 'auto',
        )

        const eventLogger = container.resolve<typeof eventLoggerModule>('eventLogger')
        if (!selected?.transition) {
          await eventLogger.logWorkflowEvent(tx, {
            workflowInstanceId: instance.id,
            stepInstanceId: activeStep.id,
            branchInstanceId: activeStep.branchInstanceId ?? undefined,
            eventType: 'SIGNAL_IGNORED',
            eventData: {
              signalName: eventName,
              reason: 'NO_VALID_AUTOMATIC_TRANSITION',
              correlationPath: activeStep.waitPayloadPath,
            },
            tenantId,
            organizationId,
          })
          return 'ignored' as const
        }

        mergeTokenContext(token, { signals: signalContext })
        if (token.kind === 'branch') {
          token.branch.status = 'ACTIVE'
          token.branch.updatedAt = new Date()
        } else {
          token.instance.status = 'RUNNING'
          token.instance.pausedAt = null
          token.instance.updatedAt = new Date()
        }

        const stepHandler = container.resolve<typeof stepHandlerModule>('stepHandler')
        await stepHandler.exitStep(tx, activeStep, {
          signalName: eventName,
          payload,
          receivedAt,
        })
        await eventLogger.logWorkflowEvent(tx, {
          workflowInstanceId: instance.id,
          stepInstanceId: activeStep.id,
          branchInstanceId: activeStep.branchInstanceId ?? undefined,
          eventType: 'SIGNAL_RECEIVED',
          eventData: {
            signalName: eventName,
            correlationPath: activeStep.waitPayloadPath,
          },
          tenantId,
          organizationId,
        })

        const transitionResult = await transitionHandler.executeTransitionForToken(
          tx,
          container,
          token,
          activeStep.stepId,
          selected.transition.toStepId,
          transitionContext,
          selected.transition.transitionId,
        )
        if (!transitionResult.success) {
          throw new SignalError(
            `Correlated signal transition failed: ${transitionResult.error || 'unknown error'}`,
            'TRANSITION_FAILED',
            { stepInstanceId: activeStep.id },
          )
        }

        return 'resumed' as const
      })

      if (outcome === 'ignored') {
        result.ignored += 1
      } else if (outcome === 'resumed') {
        result.resumed += 1
        const workflowExecutor = container.resolve<typeof workflowExecutorModule>('workflowExecutor')
        try {
          const continuation = await workflowExecutor.executeWorkflow(
            em,
            container,
            candidate.workflowInstanceId,
            { rollbackOnFailure: true },
          )
          if (continuation.status === 'FAILED') {
            throw new SignalError(
              'Automatic continuation returned a failed result',
              'CONTINUATION_FAILED',
              { workflowInstanceId: candidate.workflowInstanceId },
            )
          }
        } catch (error) {
          await markCorrelatedContinuationFailed(
            em,
            container,
            candidate.workflowInstanceId,
            candidate.branchInstanceId,
            tenantId,
            organizationId,
            error,
          )
          throw error
        }
      }
    } catch (error) {
      errors.push({
        stepInstanceId: candidate.id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  if (errors.length > 0) {
    throw new SignalError(
      `Correlated signal transition failed for ${errors.length} wait(s)`,
      'CORRELATED_SIGNAL_DELIVERY_FAILED',
      { errors },
    )
  }

  return result
}
