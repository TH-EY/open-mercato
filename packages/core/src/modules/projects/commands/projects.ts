import type { CommandHandler } from '@open-mercato/shared/lib/commands'
import { registerCommand } from '@open-mercato/shared/lib/commands'
import type { EntityManager } from '@mikro-orm/postgresql'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { SalesOrder } from '@open-mercato/core/modules/sales/data/entities'
import { Project, ProjectTask } from '../data/entities'
import {
  projectCreateSchema,
  projectUpdateSchema,
  type ProjectCreateInput,
  type ProjectUpdateInput,
} from '../data/validators'
import { emitProjectsEvent } from '../events'
import { ensureOrganizationScope, ensureTenantScope } from './shared'

async function assertScopedOrder(
  em: EntityManager,
  orderId: string | null | undefined,
  tenantId: string,
  organizationId: string,
): Promise<void> {
  if (!orderId) return
  const order = await findOneWithDecryption(
    em,
    SalesOrder,
    { id: orderId, deletedAt: null },
    undefined,
    { tenantId, organizationId },
  )
  if (!order) throw new CrudHttpError(400, { error: 'Sales order not found for this organization.' })
}

const createProjectCommand: CommandHandler<ProjectCreateInput, { projectId: string }> = {
  id: 'projects.projects.create',
  async execute(input, ctx) {
    const parsed = projectCreateSchema.parse(input)
    ensureTenantScope(ctx, parsed.tenantId)
    ensureOrganizationScope(ctx, parsed.organizationId)

    const em = (ctx.container.resolve('em') as EntityManager).fork()
    await assertScopedOrder(em, parsed.orderId, parsed.tenantId, parsed.organizationId)
    const now = new Date()
    const project = em.create(Project, {
      tenantId: parsed.tenantId,
      organizationId: parsed.organizationId,
      name: parsed.name,
      orderId: parsed.orderId ?? null,
      ownerUserId: parsed.ownerUserId ?? null,
      isActive: parsed.isActive ?? true,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    })
    em.persist(project)
    await em.flush()
    await emitProjectsEvent('projects.project.created', {
      id: project.id,
      tenantId: project.tenantId,
      organizationId: project.organizationId,
    })
    return { projectId: project.id }
  },
}

const updateProjectCommand: CommandHandler<ProjectUpdateInput, { projectId: string }> = {
  id: 'projects.projects.update',
  async execute(input, ctx) {
    const parsed = projectUpdateSchema.parse(input)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const project = await findOneWithDecryption(
      em,
      Project,
      { id: parsed.id, deletedAt: null },
      undefined,
      { tenantId: ctx.auth?.tenantId ?? null, organizationId: ctx.auth?.orgId ?? null },
    )
    if (!project) throw new CrudHttpError(404, { error: 'Project not found.' })
    ensureTenantScope(ctx, project.tenantId)
    ensureOrganizationScope(ctx, project.organizationId)
    await assertScopedOrder(em, parsed.orderId, project.tenantId, project.organizationId)

    if (parsed.name !== undefined) project.name = parsed.name
    if (parsed.orderId !== undefined) project.orderId = parsed.orderId ?? null
    if (parsed.ownerUserId !== undefined) project.ownerUserId = parsed.ownerUserId ?? null
    if (parsed.isActive !== undefined) project.isActive = parsed.isActive
    project.updatedAt = new Date()
    await em.flush()
    await emitProjectsEvent('projects.project.updated', {
      id: project.id,
      tenantId: project.tenantId,
      organizationId: project.organizationId,
    })
    return { projectId: project.id }
  },
}

const deleteProjectCommand: CommandHandler<{ id: string }, { projectId: string }> = {
  id: 'projects.projects.delete',
  async execute(input, ctx) {
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const project = await findOneWithDecryption(
      em,
      Project,
      { id: input.id, deletedAt: null },
      undefined,
      { tenantId: ctx.auth?.tenantId ?? null, organizationId: ctx.auth?.orgId ?? null },
    )
    if (!project) throw new CrudHttpError(404, { error: 'Project not found.' })
    ensureTenantScope(ctx, project.tenantId)
    ensureOrganizationScope(ctx, project.organizationId)
    const now = new Date()
    project.deletedAt = now
    project.updatedAt = now
    await em.nativeUpdate(ProjectTask, {
      project: project.id,
      tenantId: project.tenantId,
      organizationId: project.organizationId,
      deletedAt: null,
    }, {
      deletedAt: now,
      updatedAt: now,
    })
    await em.flush()
    await emitProjectsEvent('projects.project.deleted', {
      id: project.id,
      tenantId: project.tenantId,
      organizationId: project.organizationId,
    })
    return { projectId: project.id }
  },
}

registerCommand(createProjectCommand)
registerCommand(updateProjectCommand)
registerCommand(deleteProjectCommand)
