export {}

const registerCommand = jest.fn()
const findOneWithDecryption = jest.fn()
const emitProjectsEvent = jest.fn()

jest.mock('@open-mercato/shared/lib/commands', () => ({
  registerCommand,
}))

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption,
}))

jest.mock('../../events', () => ({
  emitProjectsEvent,
}))

const PROJECT_ID = '11111111-1111-4111-8111-111111111111'
const FIRST_TASK_ID = '22222222-2222-4222-8222-222222222222'
const SECOND_TASK_ID = '33333333-3333-4333-8333-333333333333'
const ORG_ID = '44444444-4444-4444-8444-444444444444'
const TENANT_ID = '55555555-5555-4555-8555-555555555555'

type RegisteredCommand = {
  id: string
  execute: (input: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<Record<string, unknown>>
}

function loadCommand(id: string): RegisteredCommand {
  registerCommand.mockClear()
  findOneWithDecryption.mockReset()
  emitProjectsEvent.mockReset()
  let command: RegisteredCommand | undefined
  jest.isolateModules(() => {
    require('../tasks')
    command = registerCommand.mock.calls.find(([candidate]) => candidate.id === id)?.[0]
  })
  if (!command) throw new Error(`command ${id} not registered`)
  return command
}

function buildContext(tasks: Array<Record<string, unknown>>) {
  const em = {
    fork: jest.fn(),
    find: jest.fn().mockResolvedValue(tasks),
    flush: jest.fn().mockResolvedValue(undefined),
    nativeUpdate: jest.fn().mockResolvedValue(1),
  }
  em.fork.mockReturnValue(em)
  return {
    em,
    ctx: {
      container: {
        resolve: jest.fn((token: string) => {
          if (token === 'em') return em
          return undefined
        }),
      },
      auth: { tenantId: TENANT_ID, orgId: ORG_ID },
    },
  }
}

describe('projects.tasks.reorder command', () => {
  it('persists scoped status and position moves', async () => {
    const command = loadCommand('projects.tasks.reorder')
    const project = { id: PROJECT_ID, tenantId: TENANT_ID, organizationId: ORG_ID }
    const firstTask = { id: FIRST_TASK_ID, status: 'todo', position: 0, updatedAt: new Date() }
    const secondTask = { id: SECOND_TASK_ID, status: 'todo', position: 1, updatedAt: new Date() }
    const { em, ctx } = buildContext([firstTask, secondTask])
    findOneWithDecryption.mockResolvedValue(project)

    const result = await command.execute({
      projectId: PROJECT_ID,
      moves: [
        { id: FIRST_TASK_ID, status: 'in_progress', position: 1 },
        { id: SECOND_TASK_ID, status: 'done', position: 0 },
      ],
    }, ctx)

    expect(result).toEqual({ moved: 2 })
    expect(firstTask).toMatchObject({ status: 'todo', position: 0 })
    expect(secondTask).toMatchObject({ status: 'todo', position: 1 })
    expect(em.find).toHaveBeenCalledWith(expect.anything(), {
      id: { $in: [FIRST_TASK_ID, SECOND_TASK_ID] },
      project: PROJECT_ID,
      tenantId: TENANT_ID,
      organizationId: ORG_ID,
      deletedAt: null,
    })
    expect(em.nativeUpdate).toHaveBeenCalledTimes(2)
    expect(em.nativeUpdate).toHaveBeenNthCalledWith(1, expect.anything(), { id: FIRST_TASK_ID }, expect.objectContaining({
      status: 'in_progress',
      position: 1,
      updatedAt: expect.any(Date),
    }))
    expect(em.nativeUpdate).toHaveBeenNthCalledWith(2, expect.anything(), { id: SECOND_TASK_ID }, expect.objectContaining({
      status: 'done',
      position: 0,
      updatedAt: expect.any(Date),
    }))
    expect(em.flush).not.toHaveBeenCalled()
    expect(emitProjectsEvent).toHaveBeenCalledWith('projects.task.moved', {
      projectId: PROJECT_ID,
      taskIds: [FIRST_TASK_ID, SECOND_TASK_ID],
      tenantId: TENANT_ID,
      organizationId: ORG_ID,
    })
  })

  it('fails closed when a moved task is outside the scoped project', async () => {
    const command = loadCommand('projects.tasks.reorder')
    const { em, ctx } = buildContext([{ id: FIRST_TASK_ID, status: 'todo', position: 0 }])
    findOneWithDecryption.mockResolvedValue({ id: PROJECT_ID, tenantId: TENANT_ID, organizationId: ORG_ID })

    await expect(command.execute({
      projectId: PROJECT_ID,
      moves: [
        { id: FIRST_TASK_ID, status: 'todo', position: 0 },
        { id: SECOND_TASK_ID, status: 'done', position: 1 },
      ],
    }, ctx)).rejects.toThrow('One or more tasks were not found in this project.')

    expect(em.nativeUpdate).not.toHaveBeenCalled()
    expect(em.flush).not.toHaveBeenCalled()
    expect(emitProjectsEvent).not.toHaveBeenCalled()
  })
})
