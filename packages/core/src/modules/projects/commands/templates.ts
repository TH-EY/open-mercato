import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandHandler } from '@open-mercato/shared/lib/commands'
import { registerCommand } from '@open-mercato/shared/lib/commands'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { ProjectTemplate, ProjectTemplateTask, ProjectTaskTemplate } from '../data/entities'
import {
  projectTemplateCreateSchema,
  projectTemplateTaskCreateSchema,
  projectTemplateTaskUpdateSchema,
  projectTemplateUpdateSchema,
  projectTaskTemplateCreateSchema,
  projectTaskTemplateUpdateSchema,
  type ProjectTemplateCreateInput,
  type ProjectTemplateTaskCreateInput,
  type ProjectTemplateTaskUpdateInput,
  type ProjectTemplateUpdateInput,
  type ProjectTaskTemplateCreateInput,
  type ProjectTaskTemplateUpdateInput,
} from '../data/validators'
import { emitProjectsEvent } from '../events'
import { normalizeProjectTaskStatus } from '../lib/statuses'
import { resolveProjectTemplateTask } from '../lib/templates'
import { ensureOrganizationScope, ensureTenantScope } from './shared'

async function loadScopedProjectTemplate(
  em: EntityManager,
  id: string,
  tenantId: string | null | undefined,
  organizationId: string | null | undefined,
): Promise<ProjectTemplate> {
  const template = await findOneWithDecryption(
    em,
    ProjectTemplate,
    { id, deletedAt: null },
    undefined,
    { tenantId: tenantId ?? null, organizationId: organizationId ?? null },
  )
  if (!template) throw new CrudHttpError(404, { error: 'Project template not found.' })
  return template
}

async function loadScopedTaskTemplate(
  em: EntityManager,
  id: string,
  tenantId: string | null | undefined,
  organizationId: string | null | undefined,
): Promise<ProjectTaskTemplate> {
  const template = await findOneWithDecryption(
    em,
    ProjectTaskTemplate,
    { id, deletedAt: null },
    undefined,
    { tenantId: tenantId ?? null, organizationId: organizationId ?? null },
  )
  if (!template) throw new CrudHttpError(404, { error: 'Project task template not found.' })
  return template
}

async function nextTemplateTaskPosition(em: EntityManager, projectTemplateId: string): Promise<number> {
  const rows = await em.find(
    ProjectTemplateTask,
    { projectTemplate: projectTemplateId, deletedAt: null },
    { orderBy: { position: 'desc' }, limit: 1 },
  )
  return (rows[0]?.position ?? -1) + 1
}

const createProjectTaskTemplateCommand: CommandHandler<ProjectTaskTemplateCreateInput, { taskTemplateId: string }> = {
  id: 'projects.task_templates.create',
  async execute(input, ctx) {
    const parsed = projectTaskTemplateCreateSchema.parse(input)
    ensureTenantScope(ctx, parsed.tenantId)
    ensureOrganizationScope(ctx, parsed.organizationId)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const now = new Date()
    const template = em.create(ProjectTaskTemplate, {
      tenantId: parsed.tenantId,
      organizationId: parsed.organizationId,
      name: parsed.name,
      status: normalizeProjectTaskStatus(parsed.status),
      description: parsed.description ?? null,
      ownerUserId: parsed.ownerUserId ?? null,
      dueInDays: parsed.dueInDays ?? null,
      isActive: parsed.isActive ?? true,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    })
    em.persist(template)
    await em.flush()
    await emitProjectsEvent('projects.task_template.created', {
      id: template.id,
      tenantId: template.tenantId,
      organizationId: template.organizationId,
    })
    return { taskTemplateId: template.id }
  },
}

const updateProjectTaskTemplateCommand: CommandHandler<ProjectTaskTemplateUpdateInput, { taskTemplateId: string }> = {
  id: 'projects.task_templates.update',
  async execute(input, ctx) {
    const parsed = projectTaskTemplateUpdateSchema.parse(input)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const template = await loadScopedTaskTemplate(em, parsed.id, ctx.auth?.tenantId ?? null, ctx.auth?.orgId ?? null)
    ensureTenantScope(ctx, template.tenantId)
    ensureOrganizationScope(ctx, template.organizationId)
    if (parsed.name !== undefined) template.name = parsed.name
    if (parsed.status !== undefined) template.status = normalizeProjectTaskStatus(parsed.status)
    if (parsed.description !== undefined) template.description = parsed.description ?? null
    if (parsed.ownerUserId !== undefined) template.ownerUserId = parsed.ownerUserId ?? null
    if (parsed.dueInDays !== undefined) template.dueInDays = parsed.dueInDays ?? null
    if (parsed.isActive !== undefined) template.isActive = parsed.isActive
    template.updatedAt = new Date()
    await em.flush()
    await emitProjectsEvent('projects.task_template.updated', {
      id: template.id,
      tenantId: template.tenantId,
      organizationId: template.organizationId,
    })
    return { taskTemplateId: template.id }
  },
}

const deleteProjectTaskTemplateCommand: CommandHandler<{ id: string }, { taskTemplateId: string }> = {
  id: 'projects.task_templates.delete',
  async execute(input, ctx) {
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const template = await loadScopedTaskTemplate(em, input.id, ctx.auth?.tenantId ?? null, ctx.auth?.orgId ?? null)
    ensureTenantScope(ctx, template.tenantId)
    ensureOrganizationScope(ctx, template.organizationId)
    template.deletedAt = new Date()
    template.updatedAt = new Date()
    await em.flush()
    await emitProjectsEvent('projects.task_template.deleted', {
      id: template.id,
      tenantId: template.tenantId,
      organizationId: template.organizationId,
    })
    return { taskTemplateId: template.id }
  },
}

const createProjectTemplateCommand: CommandHandler<ProjectTemplateCreateInput, { templateId: string }> = {
  id: 'projects.project_templates.create',
  async execute(input, ctx) {
    const parsed = projectTemplateCreateSchema.parse(input)
    ensureTenantScope(ctx, parsed.tenantId)
    ensureOrganizationScope(ctx, parsed.organizationId)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const now = new Date()
    const template = em.create(ProjectTemplate, {
      tenantId: parsed.tenantId,
      organizationId: parsed.organizationId,
      name: parsed.name,
      description: parsed.description ?? null,
      isActive: parsed.isActive ?? true,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    })
    em.persist(template)
    await em.flush()
    await emitProjectsEvent('projects.project_template.created', {
      id: template.id,
      tenantId: template.tenantId,
      organizationId: template.organizationId,
    })
    return { templateId: template.id }
  },
}

const updateProjectTemplateCommand: CommandHandler<ProjectTemplateUpdateInput, { templateId: string }> = {
  id: 'projects.project_templates.update',
  async execute(input, ctx) {
    const parsed = projectTemplateUpdateSchema.parse(input)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const template = await loadScopedProjectTemplate(em, parsed.id, ctx.auth?.tenantId ?? null, ctx.auth?.orgId ?? null)
    ensureTenantScope(ctx, template.tenantId)
    ensureOrganizationScope(ctx, template.organizationId)
    if (parsed.name !== undefined) template.name = parsed.name
    if (parsed.description !== undefined) template.description = parsed.description ?? null
    if (parsed.isActive !== undefined) template.isActive = parsed.isActive
    template.updatedAt = new Date()
    await em.flush()
    await emitProjectsEvent('projects.project_template.updated', {
      id: template.id,
      tenantId: template.tenantId,
      organizationId: template.organizationId,
    })
    return { templateId: template.id }
  },
}

const deleteProjectTemplateCommand: CommandHandler<{ id: string }, { templateId: string }> = {
  id: 'projects.project_templates.delete',
  async execute(input, ctx) {
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const template = await loadScopedProjectTemplate(em, input.id, ctx.auth?.tenantId ?? null, ctx.auth?.orgId ?? null)
    ensureTenantScope(ctx, template.tenantId)
    ensureOrganizationScope(ctx, template.organizationId)
    const now = new Date()
    template.deletedAt = now
    template.updatedAt = now
    await em.nativeUpdate(ProjectTemplateTask, {
      projectTemplate: template.id,
      tenantId: template.tenantId,
      organizationId: template.organizationId,
      deletedAt: null,
    }, {
      deletedAt: now,
      updatedAt: now,
    })
    await em.flush()
    await emitProjectsEvent('projects.project_template.deleted', {
      id: template.id,
      tenantId: template.tenantId,
      organizationId: template.organizationId,
    })
    return { templateId: template.id }
  },
}

const createProjectTemplateTaskCommand: CommandHandler<ProjectTemplateTaskCreateInput, { templateTaskId: string }> = {
  id: 'projects.project_template_tasks.create',
  async execute(input, ctx) {
    const parsed = projectTemplateTaskCreateSchema.parse(input)
    ensureTenantScope(ctx, parsed.tenantId)
    ensureOrganizationScope(ctx, parsed.organizationId)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const projectTemplate = await loadScopedProjectTemplate(em, parsed.projectTemplateId, parsed.tenantId, parsed.organizationId)
    const taskTemplate = parsed.taskTemplateId
      ? await loadScopedTaskTemplate(em, parsed.taskTemplateId, parsed.tenantId, parsed.organizationId)
      : null
    resolveProjectTemplateTask({
      name: parsed.name,
      status: parsed.status,
      description: parsed.description,
      ownerUserId: parsed.ownerUserId,
      dueInDays: parsed.dueInDays,
      position: parsed.position,
      taskTemplate,
    })
    const now = new Date()
    const templateTask = em.create(ProjectTemplateTask, {
      tenantId: parsed.tenantId,
      organizationId: parsed.organizationId,
      projectTemplate,
      taskTemplate,
      name: parsed.name ?? null,
      status: parsed.status ? normalizeProjectTaskStatus(parsed.status) : null,
      description: parsed.description ?? null,
      ownerUserId: parsed.ownerUserId ?? null,
      dueInDays: parsed.dueInDays ?? null,
      position: parsed.position ?? await nextTemplateTaskPosition(em, projectTemplate.id),
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    })
    em.persist(templateTask)
    await em.flush()
    await emitProjectsEvent('projects.project_template.task.created', {
      id: templateTask.id,
      templateId: projectTemplate.id,
      tenantId: templateTask.tenantId,
      organizationId: templateTask.organizationId,
    })
    return { templateTaskId: templateTask.id }
  },
}

const updateProjectTemplateTaskCommand: CommandHandler<ProjectTemplateTaskUpdateInput, { templateTaskId: string }> = {
  id: 'projects.project_template_tasks.update',
  async execute(input, ctx) {
    const parsed = projectTemplateTaskUpdateSchema.parse(input)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const templateTask = await findOneWithDecryption(
      em,
      ProjectTemplateTask,
      { id: parsed.id, deletedAt: null },
      { populate: ['projectTemplate', 'taskTemplate'] },
      { tenantId: ctx.auth?.tenantId ?? null, organizationId: ctx.auth?.orgId ?? null },
    )
    if (!templateTask) throw new CrudHttpError(404, { error: 'Project template task not found.' })
    ensureTenantScope(ctx, templateTask.tenantId)
    ensureOrganizationScope(ctx, templateTask.organizationId)
    let projectTemplate = templateTask.projectTemplate as ProjectTemplate
    if (parsed.projectTemplateId !== undefined && parsed.projectTemplateId !== projectTemplate.id) {
      projectTemplate = await loadScopedProjectTemplate(em, parsed.projectTemplateId, templateTask.tenantId, templateTask.organizationId)
      templateTask.projectTemplate = projectTemplate
    }
    let taskTemplate = templateTask.taskTemplate ?? null
    if (parsed.taskTemplateId !== undefined) {
      taskTemplate = parsed.taskTemplateId
        ? await loadScopedTaskTemplate(em, parsed.taskTemplateId, templateTask.tenantId, templateTask.organizationId)
        : null
    }
    resolveProjectTemplateTask({
      name: parsed.name !== undefined ? parsed.name : templateTask.name,
      status: parsed.status !== undefined ? parsed.status : templateTask.status,
      description: parsed.description !== undefined ? parsed.description : templateTask.description,
      ownerUserId: parsed.ownerUserId !== undefined ? parsed.ownerUserId : templateTask.ownerUserId,
      dueInDays: parsed.dueInDays !== undefined ? parsed.dueInDays : templateTask.dueInDays,
      position: parsed.position !== undefined ? parsed.position : templateTask.position,
      taskTemplate,
    })
    if (parsed.taskTemplateId !== undefined) templateTask.taskTemplate = taskTemplate
    if (parsed.name !== undefined) templateTask.name = parsed.name ?? null
    if (parsed.status !== undefined) templateTask.status = parsed.status ? normalizeProjectTaskStatus(parsed.status) : null
    if (parsed.description !== undefined) templateTask.description = parsed.description ?? null
    if (parsed.ownerUserId !== undefined) templateTask.ownerUserId = parsed.ownerUserId ?? null
    if (parsed.dueInDays !== undefined) templateTask.dueInDays = parsed.dueInDays ?? null
    if (parsed.position !== undefined) templateTask.position = parsed.position
    templateTask.updatedAt = new Date()
    await em.flush()
    await emitProjectsEvent('projects.project_template.task.updated', {
      id: templateTask.id,
      templateId: projectTemplate.id,
      tenantId: templateTask.tenantId,
      organizationId: templateTask.organizationId,
    })
    return { templateTaskId: templateTask.id }
  },
}

const deleteProjectTemplateTaskCommand: CommandHandler<{ id: string }, { templateTaskId: string }> = {
  id: 'projects.project_template_tasks.delete',
  async execute(input, ctx) {
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const templateTask = await findOneWithDecryption(
      em,
      ProjectTemplateTask,
      { id: input.id, deletedAt: null },
      { populate: ['projectTemplate'] },
      { tenantId: ctx.auth?.tenantId ?? null, organizationId: ctx.auth?.orgId ?? null },
    )
    if (!templateTask) throw new CrudHttpError(404, { error: 'Project template task not found.' })
    ensureTenantScope(ctx, templateTask.tenantId)
    ensureOrganizationScope(ctx, templateTask.organizationId)
    templateTask.deletedAt = new Date()
    templateTask.updatedAt = new Date()
    await em.flush()
    await emitProjectsEvent('projects.project_template.task.deleted', {
      id: templateTask.id,
      templateId: (templateTask.projectTemplate as ProjectTemplate).id,
      tenantId: templateTask.tenantId,
      organizationId: templateTask.organizationId,
    })
    return { templateTaskId: templateTask.id }
  },
}

registerCommand(createProjectTaskTemplateCommand)
registerCommand(updateProjectTaskTemplateCommand)
registerCommand(deleteProjectTaskTemplateCommand)
registerCommand(createProjectTemplateCommand)
registerCommand(updateProjectTemplateCommand)
registerCommand(deleteProjectTemplateCommand)
registerCommand(createProjectTemplateTaskCommand)
registerCommand(updateProjectTemplateTaskCommand)
registerCommand(deleteProjectTemplateTaskCommand)
