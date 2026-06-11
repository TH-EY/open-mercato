import { z } from 'zod'
import { makeCrudRoute } from '@open-mercato/shared/lib/crud/factory'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { resolveCrudRecordId, parseScopedCommandInput } from '@open-mercato/shared/lib/api/scoped'
import { escapeLikePattern } from '@open-mercato/shared/lib/db/escapeLikePattern'
import type { EntityManager } from '@mikro-orm/postgresql'
import { Project, ProjectTask } from '../data/entities'
import { projectCreateSchema, projectUpdateSchema } from '../data/validators'
import { E } from '#generated/entities.ids.generated'
import { createPagedListResponseSchema, createProjectsCrudOpenApi, defaultOkResponseSchema } from './openapi'

const routeMetadata = {
  GET: { requireAuth: true, requireFeatures: ['projects.view'] },
  POST: { requireAuth: true, requireFeatures: ['projects.manage'] },
  PUT: { requireAuth: true, requireFeatures: ['projects.manage'] },
  DELETE: { requireAuth: true, requireFeatures: ['projects.manage'] },
}

export const metadata = routeMetadata

const rawBodySchema = z.object({}).passthrough()

const listSchema = z
  .object({
    page: z.coerce.number().min(1).default(1),
    pageSize: z.coerce.number().min(1).max(100).default(50),
    ids: z.string().optional(),
    search: z.string().optional(),
    orderId: z.string().uuid().optional(),
    ownerUserId: z.string().uuid().optional(),
    sortField: z.string().optional(),
    sortDir: z.enum(['asc', 'desc']).optional(),
  })
  .passthrough()

function parseIds(value?: string): string[] {
  if (!value) return []
  return value.split(',').map((item) => item.trim()).filter(Boolean)
}

const crud = makeCrudRoute({
  metadata: routeMetadata,
  orm: {
    entity: Project,
    idField: 'id',
    orgField: 'organizationId',
    tenantField: 'tenantId',
    softDeleteField: 'deletedAt',
  },
  indexer: { entityType: E.projects.project },
  list: {
    schema: listSchema,
    entityId: E.projects.project,
    fields: [
      'id',
      'organization_id',
      'tenant_id',
      'name',
      'order_id',
      'owner_user_id',
      'is_active',
      'created_at',
      'updated_at',
    ],
    sortFieldMap: {
      name: 'name',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    },
    buildFilters: async (query) => {
      const filters: Record<string, unknown> = {}
      const ids = parseIds(query.ids)
      if (ids.length) filters.id = { $in: ids }
      if (query.search) {
        const term = query.search.trim()
        if (term.length) filters.name = { $ilike: `%${escapeLikePattern(term)}%` }
      }
      if (query.orderId) filters.order_id = query.orderId
      if (query.ownerUserId) filters.owner_user_id = query.ownerUserId
      return filters
    },
  },
  hooks: {
    afterList: async (payload, ctx) => {
      const items = Array.isArray(payload?.items) ? payload.items as Array<Record<string, unknown>> : []
      if (items.length === 0) return
      const ids = items.map((item) => typeof item.id === 'string' ? item.id : '').filter(Boolean)
      if (ids.length === 0) return
      const em = (ctx.container.resolve('em') as EntityManager).fork()
      const tasks = await em.find(ProjectTask, { project: { $in: ids }, deletedAt: null }, { populate: ['project'] })
      const counts = new Map<string, { open: number; done: number }>()
      for (const task of tasks) {
        const projectId = (task.project as Project).id
        const current = counts.get(projectId) ?? { open: 0, done: 0 }
        if (task.status === 'done') current.done += 1
        else current.open += 1
        counts.set(projectId, current)
      }
      for (const item of items) {
        const id = typeof item.id === 'string' ? item.id : ''
        const count = counts.get(id) ?? { open: 0, done: 0 }
        item.openTaskCount = count.open
        item.doneTaskCount = count.done
      }
    },
  },
  actions: {
    create: {
      commandId: 'projects.projects.create',
      schema: rawBodySchema,
      mapInput: async ({ raw, ctx }) => {
        const { translate } = await resolveTranslations()
        return parseScopedCommandInput(projectCreateSchema, raw ?? {}, ctx, translate)
      },
      response: ({ result }) => ({ id: result?.projectId ?? null }),
      status: 201,
    },
    update: {
      commandId: 'projects.projects.update',
      schema: rawBodySchema,
      mapInput: async ({ raw, ctx }) => {
        const { translate } = await resolveTranslations()
        return parseScopedCommandInput(projectUpdateSchema, raw ?? {}, ctx, translate)
      },
      response: () => ({ ok: true }),
    },
    delete: {
      commandId: 'projects.projects.delete',
      schema: rawBodySchema,
      mapInput: async ({ parsed, ctx }) => {
        const { translate } = await resolveTranslations()
        return { id: resolveCrudRecordId(parsed, ctx, translate) }
      },
      response: () => ({ ok: true }),
    },
  },
})

export const GET = crud.GET
export const POST = crud.POST
export const PUT = crud.PUT
export const DELETE = crud.DELETE

const projectListItemSchema = z.object({
  id: z.string().uuid().nullable().optional(),
  organization_id: z.string().uuid().nullable().optional(),
  tenant_id: z.string().uuid().nullable().optional(),
  name: z.string().nullable().optional(),
  order_id: z.string().uuid().nullable().optional(),
  owner_user_id: z.string().uuid().nullable().optional(),
  is_active: z.boolean().nullable().optional(),
  openTaskCount: z.number().nullable().optional(),
  doneTaskCount: z.number().nullable().optional(),
  created_at: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
})

export const openApi = createProjectsCrudOpenApi({
  resourceName: 'Project',
  pluralName: 'Projects',
  querySchema: listSchema,
  listResponseSchema: createPagedListResponseSchema(projectListItemSchema),
  create: {
    schema: projectCreateSchema,
    description: 'Creates an organization-scoped project.',
  },
  update: {
    schema: projectUpdateSchema,
    responseSchema: defaultOkResponseSchema,
    description: 'Updates a project by id.',
  },
  del: {
    schema: z.object({ id: z.string().uuid() }),
    responseSchema: defaultOkResponseSchema,
    description: 'Soft-deletes a project by id.',
  },
})
