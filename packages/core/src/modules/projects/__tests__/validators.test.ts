import {
  projectTaskCreateSchema,
  projectTaskReorderSchema,
} from '../data/validators'
import {
  normalizeProjectTaskStatus,
  projectTaskStatusLabels,
  projectTaskStatuses,
} from '../lib/statuses'

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
})
