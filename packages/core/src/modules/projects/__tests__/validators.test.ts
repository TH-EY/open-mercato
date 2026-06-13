import {
  projectTemplateTaskCreateSchema,
  projectTaskCreateSchema,
  projectTaskReorderSchema,
  projectTaskTemplateCreateSchema,
} from '../data/validators'
import {
  normalizeProjectTaskStatus,
  projectTaskStatusLabels,
  projectTaskStatuses,
} from '../lib/statuses'
import { deadlineFromDueInDays, resolveProjectTemplateTask } from '../lib/templates'

const PROJECT_ID = '11111111-1111-4111-8111-111111111111'
const TASK_ID = '22222222-2222-4222-8222-222222222222'
const ORG_ID = '33333333-3333-4333-8333-333333333333'
const TENANT_ID = '44444444-4444-4444-8444-444444444444'

describe('projects validators and statuses', () => {
  it('keeps v1 task statuses centralized and label-ready', () => {
    expect(projectTaskStatuses).toEqual(['todo', 'in_progress', 'done'])
    expect(projectTaskStatusLabels).toEqual({
      todo: 'Todo',
      in_progress: 'In progress',
      done: 'Done',
    })
    expect(normalizeProjectTaskStatus('in_progress')).toBe('in_progress')
    expect(normalizeProjectTaskStatus('unknown')).toBe('todo')
  })

  it('defaults new tasks to todo and coerces deadline and position', () => {
    const parsed = projectTaskCreateSchema.parse({
      tenantId: TENANT_ID,
      organizationId: ORG_ID,
      projectId: PROJECT_ID,
      name: '  Prepare EPC docs  ',
      deadlineAt: '2026-06-20T00:00:00.000Z',
      position: '2',
    })

    expect(parsed.name).toBe('Prepare EPC docs')
    expect(parsed.status).toBe('todo')
    expect(parsed.deadlineAt).toBeInstanceOf(Date)
    expect(parsed.position).toBe(2)
  })

  it('rejects empty reorder moves and unknown task statuses', () => {
    expect(() => projectTaskReorderSchema.parse({ projectId: PROJECT_ID, moves: [] })).toThrow()
    expect(() => projectTaskReorderSchema.parse({
      projectId: PROJECT_ID,
      moves: [{ id: TASK_ID, status: 'blocked', position: 0 }],
    })).toThrow()
  })

  it('validates task templates and project template task overrides', () => {
    const taskTemplate = projectTaskTemplateCreateSchema.parse({
      tenantId: TENANT_ID,
      organizationId: ORG_ID,
      name: '  Kickoff  ',
      status: 'in_progress',
      dueInDays: '7',
    })
    expect(taskTemplate.name).toBe('Kickoff')
    expect(taskTemplate.dueInDays).toBe(7)

    const templateTask = projectTemplateTaskCreateSchema.parse({
      tenantId: TENANT_ID,
      organizationId: ORG_ID,
      projectTemplateId: PROJECT_ID,
      taskTemplateId: TASK_ID,
      position: '3',
      status: null,
    })
    expect(templateTask.position).toBe(3)
    expect(templateTask.status).toBeNull()
  })

  it('resolves task template values with project template overrides', () => {
    const resolved = resolveProjectTemplateTask({
      name: null,
      status: 'done',
      dueInDays: null,
      position: 2,
      taskTemplate: {
        name: 'Template task',
        status: 'todo',
        description: 'Template description',
        ownerUserId: TASK_ID,
        dueInDays: 5,
      },
    })

    expect(resolved).toMatchObject({
      name: 'Template task',
      status: 'done',
      description: 'Template description',
      ownerUserId: TASK_ID,
      dueInDays: 5,
      position: 2,
    })
  })

  it('calculates deadlines from relative due-in-days', () => {
    const deadline = deadlineFromDueInDays(new Date('2026-06-13T10:00:00.000Z'), 7)
    expect(deadline?.toISOString()).toBe('2026-06-20T10:00:00.000Z')
    expect(deadlineFromDueInDays(new Date('2026-06-13T10:00:00.000Z'), null)).toBeNull()
  })

  it('rejects template tasks that cannot resolve a final name', () => {
    expect(() => resolveProjectTemplateTask({ status: 'todo', position: 0, taskTemplate: null })).toThrow()
  })
})
