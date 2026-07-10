import { LockMode } from '@mikro-orm/core'
import { claimUserTask, completeUserTask, UserTaskError } from '../task-handler'
import {
  UserTask,
  WorkflowDefinition,
  WorkflowInstance,
  StepInstance,
} from '../../data/entities'

describe('task-handler', () => {
  const tenantId = '00000000-0000-4000-8000-000000000001'
  const organizationId = '00000000-0000-4000-8000-000000000002'
  const taskId = '00000000-0000-4000-8000-000000000003'
  const workflowInstanceId = '00000000-0000-4000-8000-000000000004'
  const definitionId = '00000000-0000-4000-8000-000000000005'
  const stepInstanceId = '00000000-0000-4000-8000-000000000006'

  function createPendingTask(): UserTask {
    return {
      id: taskId,
      workflowInstanceId,
      stepInstanceId,
      branchInstanceId: null,
      taskName: 'Initial contact',
      description: null,
      status: 'PENDING',
      formSchema: {
        fields: [
          {
            name: 'contact_summary',
            type: 'textarea',
            label: 'Contact Summary',
            required: true,
          },
        ],
      },
      formData: null,
      assignedTo: 'qa-user',
      assignedToRoles: null,
      claimedBy: null,
      claimedAt: null,
      dueDate: null,
      escalatedAt: null,
      escalatedTo: null,
      completedBy: null,
      completedAt: null,
      comments: null,
      tenantId,
      organizationId,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as UserTask
  }

  function createEntityManager(task: UserTask) {
    const instance = {
      id: workflowInstanceId,
      definitionId,
      workflowId: 'qa-user-task-form',
      version: 1,
      status: 'PAUSED',
      currentStepId: 'initial_contact',
      context: {},
      tenantId,
      organizationId,
      updatedAt: new Date(),
    } as WorkflowInstance

    const definition = {
      id: definitionId,
      definition: {
        transitions: [],
      },
      tenantId,
      organizationId,
    } as WorkflowDefinition

    const em: any = {
        findOne: jest.fn(async (entity: unknown) => {
          if (entity === UserTask) return task
          if (entity === WorkflowInstance) return instance
          if (entity === StepInstance) return null
          if (entity === WorkflowDefinition) return definition
          return null
        }),
        create: jest.fn((_: unknown, payload: unknown) => payload),
        persist: jest.fn(function persist(this: any) { return this }),
        flush: jest.fn(),
    }
    em.transactional = jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(em))

    return {
      instance,
      em,
    }
  }

  test('rejects missing required data for visual-editor fields schema', async () => {
    const task = createPendingTask()
    const { em } = createEntityManager(task)

    await expect(
      completeUserTask(em as any, {} as any, {
        taskId,
        formData: {},
        userId: 'qa-user',
        tenantId,
        organizationId,
      })
    ).rejects.toMatchObject({
      name: 'UserTaskError',
      code: 'FORM_VALIDATION_FAILED',
      message: 'Required field missing: contact_summary',
    } satisfies Partial<UserTaskError>)

    expect(task.status).toBe('PENDING')
    expect(em.flush).not.toHaveBeenCalled()
  })

  test('persists form data from visual-editor fields schema and merges it into workflow context', async () => {
    const task = createPendingTask()
    const { em, instance } = createEntityManager(task)

    await completeUserTask(em as any, {} as any, {
      taskId,
      formData: { contact_summary: 'Reached the customer by phone.' },
      userId: 'qa-user',
      tenantId,
      organizationId,
      comments: 'Useful first call',
    })

    expect(task.status).toBe('COMPLETED')
    expect(task.formData).toEqual({ contact_summary: 'Reached the customer by phone.' })
    expect(task.comments).toBe('Useful first call')
    expect(instance.context).toEqual({ contact_summary: 'Reached the customer by phone.' })
    expect(em.flush).toHaveBeenCalled()
    expect(em.findOne).toHaveBeenCalledWith(
      UserTask,
      { id: taskId, tenantId, organizationId },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    )
  })

  test('hides a directly assigned task from another user on completion', async () => {
    const task = createPendingTask()
    const { em } = createEntityManager(task)

    await expect(
      completeUserTask(em as any, {} as any, {
        taskId,
        formData: { contact_summary: 'Should not be accepted.' },
        userId: 'another-user',
        tenantId,
        organizationId,
      })
    ).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' })

    expect(task.status).toBe('PENDING')
  })

  test('allows only a matching role candidate to claim a scoped task', async () => {
    const task = createPendingTask()
    task.assignedTo = null
    task.assignedToRoles = ['Sales Representative']
    const { em } = createEntityManager(task)

    await claimUserTask(em as any, {
      taskId,
      userId: 'qa-user',
      userRoles: ['Sales Representative'],
      tenantId,
      organizationId,
    })

    expect(task.status).toBe('IN_PROGRESS')
    expect(task.claimedBy).toBe('qa-user')
  })

  test('rejects a role queue claim from an unrelated role', async () => {
    const task = createPendingTask()
    task.assignedTo = null
    task.assignedToRoles = ['Sales Representative']
    const { em } = createEntityManager(task)

    await expect(
      claimUserTask(em as any, {
        taskId,
        userId: 'qa-user',
        userRoles: ['Support'],
        tenantId,
        organizationId,
      })
    ).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' })

    expect(task.status).toBe('PENDING')
  })

  test('hides a task from a role peer after another user claims it', async () => {
    const task = createPendingTask()
    task.assignedTo = null
    task.assignedToRoles = ['Sales Representative']
    task.status = 'IN_PROGRESS'
    task.claimedBy = 'first-user'
    const { em } = createEntityManager(task)

    await expect(
      claimUserTask(em as any, {
        taskId,
        userId: 'second-user',
        userRoles: ['Sales Representative'],
        tenantId,
        organizationId,
      })
    ).rejects.toMatchObject({
      code: 'TASK_NOT_FOUND',
      details: { taskId },
    })
  })
})
