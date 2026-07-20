/**
 * Workflows Module - User Task Handler Service
 *
 * Handles user task lifecycle operations:
 * - Completing user tasks
 * - Claiming tasks from role queues
 * - Reassigning tasks
 * - Escalating overdue tasks
 *
 * Functional API (no classes) following Open Mercato conventions.
 */

import { EntityManager, LockMode } from '@mikro-orm/core'
import type { AwilixContainer } from 'awilix'
import {
  UserTask,
  WorkflowInstance,
  WorkflowEvent,
  StepInstance,
  WorkflowDefinition,
} from '../data/entities'
import { executeWorkflow } from './workflow-executor'
import * as stepHandler from './step-handler'
import * as transitionHandler from './transition-handler'
import { normalizeUserTaskFormSchema } from './user-task-form-schema'

// ============================================================================
// Types and Interfaces
// ============================================================================

export interface CompleteUserTaskOptions {
  taskId: string
  formData: Record<string, any>
  userId: string
  tenantId: string
  organizationId: string
  comments?: string
}

export interface ClaimUserTaskOptions {
  taskId: string
  userId: string
  userRoles: string[]
  tenantId: string
  organizationId: string
}

export class UserTaskError extends Error {
  constructor(
    message: string,
    public code: string,
    public details?: any
  ) {
    super(message)
    this.name = 'UserTaskError'
  }
}

// ============================================================================
// User Task Completion
// ============================================================================

/**
 * Complete a user task and resume workflow execution
 *
 * This function:
 * 1. Validates the task exists and can be completed
 * 2. Updates the task with form data and completion info
 * 3. Merges form data into workflow context
 * 4. Logs completion event
 * 5. Resumes workflow execution
 *
 * @param em - Entity manager
 * @param container - DI container for workflow execution
 * @param options - Task completion options
 * @throws UserTaskError if task not found or validation fails
 */
export async function completeUserTask(
  em: EntityManager,
  container: AwilixContainer,
  options: CompleteUserTaskOptions
): Promise<void> {
  await em.transactional(async (tx) => {
    await completeUserTaskInTransaction(tx, container, options)
  })
}

async function completeUserTaskInTransaction(
  em: EntityManager,
  container: AwilixContainer,
  options: CompleteUserTaskOptions
): Promise<void> {
  const { taskId, formData, userId, tenantId, organizationId, comments } = options

  // Lock the scoped row before checking its lifecycle state. This makes the
  // completion and the workflow resume a single-winner operation.
  const task = await em.findOne(UserTask, {
    id: taskId,
    tenantId,
    organizationId,
  }, { lockMode: LockMode.PESSIMISTIC_WRITE })

  if (!task) {
    throw new UserTaskError(
      'Task not found',
      'TASK_NOT_FOUND',
      { taskId }
    )
  }

  if (task.status !== 'PENDING' && task.status !== 'IN_PROGRESS') {
    throw new UserTaskError(
      'Task is no longer available for completion',
      'TASK_STATE_CONFLICT',
      { taskId, status: task.status }
    )
  }

  const isDirectAssignee = task.assignedTo === userId
  const isClaimedOwner = !task.assignedTo && task.status === 'IN_PROGRESS' && task.claimedBy === userId
  if (!isDirectAssignee && !isClaimedOwner) {
    // Deliberately hide whether an otherwise scoped task exists.
    throw new UserTaskError('Task not found', 'TASK_NOT_FOUND', { taskId })
  }

  // Validate form data against schema (simple validation for MVP)
  // In Phase 7, we'll add comprehensive JSON Schema validation
  if (task.formSchema) {
    try {
      validateFormData(formData, task.formSchema)
    } catch (error) {
      throw new UserTaskError(
        error instanceof Error ? error.message : 'Form validation failed',
        'FORM_VALIDATION_FAILED',
        { taskId, formSchema: task.formSchema, formData }
      )
    }
  }

  // Update task
  const now = new Date()
  task.status = 'COMPLETED'
  task.formData = formData
  task.completedBy = userId
  task.completedAt = now
  task.comments = comments || null
  task.updatedAt = now

  await em.flush()

  // Fetch workflow instance
  const instance = await em.findOne(WorkflowInstance, {
    id: task.workflowInstanceId,
    tenantId,
    organizationId,
  })
  if (!instance) {
    throw new UserTaskError(
      'Workflow instance not found',
      'INSTANCE_NOT_FOUND',
      { workflowInstanceId: task.workflowInstanceId }
    )
  }

  // Branch-scoped completion: when the task belongs to a parallel branch,
  // merge form data into the branch namespace and resume just that branch.
  if (task.branchInstanceId) {
    await logWorkflowEvent(em, {
      workflowInstanceId: instance.id,
      stepInstanceId: task.stepInstanceId,
      branchInstanceId: task.branchInstanceId,
      eventType: 'USER_TASK_COMPLETED',
      eventData: { taskId: task.id, taskName: task.taskName, completedBy: userId, formData },
      userId,
      tenantId: instance.tenantId,
      organizationId: instance.organizationId,
    })

    const { resumeBranch } = await import('./parallel-handler')
    const resumed = await resumeBranch(em, {
      instanceId: instance.id,
      branchInstanceId: task.branchInstanceId,
      tenantId: instance.tenantId,
      organizationId: instance.organizationId,
      contextMerge: formData,
      exitStepInstanceId: task.stepInstanceId,
      exitOutput: { userTaskId: task.id, formData },
    })

    if (resumed) {
      await executeWorkflow(em, container, instance.id, { userId })
    }
    return
  }

  // Merge form data into workflow context
  instance.context = {
    ...instance.context,
    ...formData,
  }
  instance.updatedAt = now

  // Log USER_TASK_COMPLETED event
  await logWorkflowEvent(em, {
    workflowInstanceId: instance.id,
    stepInstanceId: task.stepInstanceId,
    eventType: 'USER_TASK_COMPLETED',
    eventData: {
      taskId: task.id,
      taskName: task.taskName,
      completedBy: userId,
      formData,
    },
    userId,
    tenantId: instance.tenantId,
    organizationId: instance.organizationId,
  })

  // Mark the step instance as completed
  const stepInstance = await em.findOne(StepInstance, {
    id: task.stepInstanceId,
    status: 'ACTIVE',
    tenantId,
    organizationId,
  })

  if (stepInstance) {
    await stepHandler.exitStep(em, stepInstance, { userTaskId: task.id, formData })
  }

  // Find the next automatic transition from the current step
  const currentStepId = instance.currentStepId

  // Load workflow definition to find transitions
  const definition = await em.findOne(WorkflowDefinition, {
    id: instance.definitionId,
    tenantId,
    organizationId,
  })

  if (!definition) {
    throw new UserTaskError(
      'Workflow definition not found',
      'DEFINITION_NOT_FOUND',
      { definitionId: instance.definitionId }
    )
  }

  // Find automatic transitions from current step
  const autoTransitions = (definition.definition.transitions || []).filter(
    (t: any) => t.fromStepId === currentStepId && t.trigger === 'auto'
  )

  if (autoTransitions.length === 0) {
    // No automatic transitions, workflow stays paused at current step
    return
  }

  // Find valid transitions using transition handler
  const transitionContext = {
    workflowContext: instance.context,
    userId,
  }

  const validTransitions = await transitionHandler.findValidTransitions(
    em,
    instance,
    currentStepId,
    transitionContext
  )

  const firstValidTransition = validTransitions.find(t => t.isValid)

  if (!firstValidTransition || !firstValidTransition.transition) {
    // Resume workflow execution anyway, maybe conditions will be met later
    instance.status = 'RUNNING'
    await em.flush()
    return
  }

  // Execute the transition to move to next step

  const transitionResult = await transitionHandler.executeTransition(
    em,
    container,
    instance,
    currentStepId,
    firstValidTransition.transition.toStepId,
    transitionContext,
    firstValidTransition.transition.transitionId,
  )

  if (!transitionResult.success) {
    console.error(`[TaskHandler] Transition failed:`, transitionResult.error)
    // Don't throw, just leave workflow in current state
    return
  }

  // Now continue workflow execution from the new step
  await executeWorkflow(em, container, instance.id, { userId })
}

/**
 * Claim a user task from a role queue
 *
 * Allows a user to claim a task that's assigned to their role(s).
 * Prevents race conditions by checking task status.
 *
 * @param em - Entity manager
 * @param taskId - Task ID to claim
 * @param userId - User claiming the task
 * @throws UserTaskError if task cannot be claimed
 */
export async function claimUserTask(
  em: EntityManager,
  options: ClaimUserTaskOptions
): Promise<void> {
  await em.transactional(async (tx) => {
    const { taskId, userId, userRoles, tenantId, organizationId } = options
    const task = await tx.findOne(UserTask, {
      id: taskId,
      tenantId,
      organizationId,
    }, { lockMode: LockMode.PESSIMISTIC_WRITE })

    if (!task) {
      throw new UserTaskError('Task not found', 'TASK_NOT_FOUND', { taskId })
    }

    const candidateRoles = task.assignedToRoles ?? []
    const isCandidate = !task.assignedTo && candidateRoles.some((role) => userRoles.includes(role))
    if (!isCandidate) {
      throw new UserTaskError('Task not found', 'TASK_NOT_FOUND', { taskId })
    }

    if (task.claimedBy && task.claimedBy !== userId) {
      // Once a shared task is claimed, hide it from former role candidates.
      throw new UserTaskError('Task not found', 'TASK_NOT_FOUND', { taskId })
    }

    if (task.status !== 'PENDING' || task.claimedBy) {
      throw new UserTaskError(
        'Task is no longer available to claim',
        'TASK_STATE_CONFLICT',
        { taskId, status: task.status, claimedBy: task.claimedBy }
      )
    }

    const now = new Date()
    task.claimedBy = userId
    task.claimedAt = now
    task.status = 'IN_PROGRESS'
    task.updatedAt = now

    await tx.flush()

    const instance = await tx.findOne(WorkflowInstance, {
      id: task.workflowInstanceId,
      tenantId,
      organizationId,
    })
    if (instance) {
      await logWorkflowEvent(tx, {
        workflowInstanceId: instance.id,
        stepInstanceId: task.stepInstanceId,
        eventType: 'USER_TASK_STARTED',
        eventData: {
          taskId: task.id,
          taskName: task.taskName,
          claimedBy: userId,
        },
        userId,
        tenantId: instance.tenantId,
        organizationId: instance.organizationId,
      })
    }
  })
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Log workflow event to event sourcing table
 */
async function logWorkflowEvent(
  em: EntityManager,
  event: {
    workflowInstanceId: string
    stepInstanceId: string | null
    branchInstanceId?: string | null
    eventType: string
    eventData: any
    userId?: string
    tenantId: string
    organizationId: string
  }
): Promise<WorkflowEvent> {
  const workflowEvent = em.create(WorkflowEvent, {
    ...event,
    occurredAt: new Date(),
  })

  await em.persist(workflowEvent).flush()
  return workflowEvent
}

/**
 * Validate form data against JSON schema (basic validation for MVP)
 *
 * In Phase 7, we'll implement comprehensive JSON Schema validation.
 * For MVP, we do basic type checking.
 *
 * @param formData - User-provided form data
 * @param formSchema - JSON schema defining expected structure
 * @throws Error if validation fails
 */
function validateFormData(
  formData: Record<string, any>,
  formSchema: any
): void {
  const normalizedSchema = normalizeUserTaskFormSchema(formSchema) ?? formSchema

  // For MVP: Basic validation - just check required fields exist
  if (!normalizedSchema || !normalizedSchema.properties) {
    return // No schema to validate against
  }

  const requiredFields = normalizedSchema.required || []

  for (const field of requiredFields) {
    if (!(field in formData) || formData[field] === null || formData[field] === undefined) {
      throw new Error(`Required field missing: ${field}`)
    }
  }

  // Additional type validation can be added in Phase 7
  // For now, this basic validation is sufficient
}
