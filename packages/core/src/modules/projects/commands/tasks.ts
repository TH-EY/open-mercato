import type { CommandHandler } from '@open-mercato/shared/lib/commands'
import { registerCommand } from '@open-mercato/shared/lib/commands'
import type { EntityManager } from '@mikro-orm/postgresql'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { Project, ProjectTask } from '../data/entities'
import {
  projectTaskCreateSchema,
  projectTaskReorderSchema,
  projectTaskUpdateSchema,
  type ProjectTaskCreateInput,
  type ProjectTaskReorderInput,
  type ProjectTaskUpdateInput,
} from '../data/validators'
import { normalizeProjectTaskStatus } from '../lib/statuses'
import { emitProjectsEvent } from '../events'
import { ensureOrganizationScope, ensureTenantScope } from './shared'

async function loadScopedProject(
  em: EntityManager,
  id: string,
  tenantId: string | null | undefined,
  organizationId: string | null | undefined,
): Promise<Project> {
  const project = await findOneWithDecryption(
    em,
    Project,
    { id, deletedAt: null },
    undefined,
    { tenantId: tenantId ?? null, organizationId: organizationId ?? null },
  )
  if (!project) throw new CrudHttpError(404, { error: 'Project not found.' })
  return project
}

async function nextTaskPosition(em: EntityManager, projectId: string, status: string): Promise<number> {
  const rows = await em.find(
    ProjectTask,
    { project: projectId, status, deletedAt: null },
    { orderBy: { position: 'desc' }, limit: 1 },
  )
  return (rows[0]?.position ?? -1) + 1
}

const createProjectTaskCommand: CommandHandler<ProjectTaskCreateInput, { taskId: string }> = {
  id: 'projects.tasks.create',
  async execute(input, ctx) {
    const parsed = projectTaskCreateSchema.parse(input)
    ensureTenantScope(ctx, parsed.tenantId)
    ensureOrganizationScope(ctx, parsed.organizationId)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const project = await loadScopedProject(em, parsed.projectId, parsed.tenantId, parsed.organizationId)
    const status = normalizeProjectTaskStatus(parsed.status)
    const now = new Date()
    const task = em.create(ProjectTask, {
      tenantId: parsed.tenantId,
      organizationId: parsed.organizationId,
      project,
      name: parsed.name,
      status,
      description: parsed.description ?? null,
      ownerUserId: parsed.ownerUserId ?? null,
      deadlineAt: parsed.deadlineAt ?? null,
      position: parsed.position ?? await nextTaskPosition(em, project.id, status),
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    })
    em.persist(task)
    await em.flush()
    await emitProjectsEvent('projects.task.created', {
      id: task.id,
      projectId: project.id,
      tenantId: task.tenantId,
      organizationId: task.organizationId,
    })
    return { taskId: task.id }
  },
}

const updateProjectTaskCommand: CommandHandler<ProjectTaskUpdateInput, { taskId: string }> = {
  id: 'projects.tasks.update',
  async execute(input, ctx) {
    const parsed = projectTaskUpdateSchema.parse(input)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const task = await findOneWithDecryption(
      em,
      ProjectTask,
      { id: parsed.id, deletedAt: null },
      { populate: ['project'] },
      { tenantId: ctx.auth?.tenantId ?? null, organizationId: ctx.auth?.orgId ?? null },
    )
    if (!task) throw new CrudHttpError(404, { error: 'Project task not found.' })
    ensureTenantScope(ctx, task.tenantId)
    ensureOrganizationScope(ctx, task.organizationId)
    const currentProject = task.project as Project
    let project = currentProject
    if (parsed.projectId !== undefined && parsed.projectId !== currentProject.id) {
      project = await loadScopedProject(em, parsed.projectId, task.tenantId, task.organizationId)
      task.project = project
    }
    if (parsed.name !== undefined) task.name = parsed.name
    if (parsed.status !== undefined) task.status = normalizeProjectTaskStatus(parsed.status)
    if (parsed.description !== undefined) task.description = parsed.description ?? null
    if (parsed.ownerUserId !== undefined) task.ownerUserId = parsed.ownerUserId ?? null
    if (parsed.deadlineAt !== undefined) task.deadlineAt = parsed.deadlineAt ?? null
    if (parsed.position !== undefined) task.position = parsed.position
    task.updatedAt = new Date()
    await em.flush()
    await emitProjectsEvent('projects.task.updated', {
      id: task.id,
      projectId: project.id,
      tenantId: task.tenantId,
      organizationId: task.organizationId,
    })
    return { taskId: task.id }
  },
}

const deleteProjectTaskCommand: CommandHandler<{ id: string }, { taskId: string }> = {
  id: 'projects.tasks.delete',
  async execute(input, ctx) {
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const task = await findOneWithDecryption(
      em,
      ProjectTask,
      { id: input.id, deletedAt: null },
      { populate: ['project'] },
      { tenantId: ctx.auth?.tenantId ?? null, organizationId: ctx.auth?.orgId ?? null },
    )
    if (!task) throw new CrudHttpError(404, { error: 'Project task not found.' })
    ensureTenantScope(ctx, task.tenantId)
    ensureOrganizationScope(ctx, task.organizationId)
    task.deletedAt = new Date()
    task.updatedAt = new Date()
    await em.flush()
    await emitProjectsEvent('projects.task.deleted', {
      id: task.id,
      projectId: (task.project as Project).id,
      tenantId: task.tenantId,
      organizationId: task.organizationId,
    })
    return { taskId: task.id }
  },
}

const reorderProjectTasksCommand: CommandHandler<ProjectTaskReorderInput, { moved: number }> = {
  id: 'projects.tasks.reorder',
  async execute(input, ctx) {
    const parsed = projectTaskReorderSchema.parse(input)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const project = await loadScopedProject(em, parsed.projectId, ctx.auth?.tenantId ?? null, ctx.auth?.orgId ?? null)
    ensureTenantScope(ctx, project.tenantId)
    ensureOrganizationScope(ctx, project.organizationId)
    const ids = parsed.moves.map((move) => move.id)
    const tasks = await em.find(ProjectTask, {
      id: { $in: ids },
      project: project.id,
      tenantId: project.tenantId,
      organizationId: project.organizationId,
      deletedAt: null,
    })
    if (tasks.length !== ids.length) throw new CrudHttpError(400, { error: 'One or more tasks were not found in this project.' })
    const taskById = new Map(tasks.map((task) => [task.id, task]))
    const now = new Date()
    let moved = 0
    for (const move of parsed.moves) {
      const task = taskById.get(move.id)
      if (!task) continue
      await em.nativeUpdate(ProjectTask, { id: task.id }, {
        status: normalizeProjectTaskStatus(move.status),
        position: move.position,
        updatedAt: now,
      })
      moved += 1
    }
    await emitProjectsEvent('projects.task.moved', {
      projectId: project.id,
      taskIds: ids,
      tenantId: project.tenantId,
      organizationId: project.organizationId,
    })
    return { moved }
  },
}

registerCommand(createProjectTaskCommand)
registerCommand(updateProjectTaskCommand)
registerCommand(deleteProjectTaskCommand)
registerCommand(reorderProjectTasksCommand)
