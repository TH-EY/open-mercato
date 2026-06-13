import { z } from 'zod'
import { makeCrudRoute } from '@open-mercato/shared/lib/crud/factory'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { resolveCrudRecordId, parseScopedCommandInput } from '@open-mercato/shared/lib/api/scoped'
import { escapeLikePattern } from '@open-mercato/shared/lib/db/escapeLikePattern'
import type { EntityManager } from '@mikro-orm/postgresql'
import { ProjectTemplate, ProjectTemplateTask } from '../../data/entities'
import { projectTemplateCreateSchema, projectTemplateUpdateSchema } from '../../data/validators'
import { E } from '#generated/entities.ids.generated'
import { createPagedListResponseSchema, createProjectsCrudOpenApi, defaultOkResponseSchema } from '../openapi'

const routeMetadata = {
  GET: { requireAuth: true, requireFeatures: ['projects.view'] },
  POST: { requireAuth: true, requireFeatures: ['projects.templates.manage'] },
  PUT: { requireAuth: true, requireFeatures: ['projects.templates.manage'] },
  DELETE: { requireAuth: true, requireFeatures: ['projects.templates.manage'] },
}

export const metadata = routeMetadata

const rawBodySchema = z.object({}).passthrough()

const listSchema = z
  .object({
    page: z.coerce.number().min(1).default(1),
    pageSize: z.coerce.number().min(1).max(100).default(50),
    ids: z.string().optional(),
    search: z.string().optional(),
    isActive: z.coerce.boolean().optional(),
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
    entity: ProjectTemplate,
    idField: 'id',
    orgField: 'organizationId',
    tenantField: 'tenantId',
    softDeleteField: 'deletedAt',
  },
  indexer: { entityType: E.projects.project_template },
  list: {
    schema: listSchema,
    entityId: E.projects.project_template,
    fields: [
      'id',
      'organization_id',
      'tenant_id',
      'name',
      'description',
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
      if (query.isActive !== undefined) filters.is_active = query.isActive
      if (query.search) {
        const term = query.search.trim()
        if (term.length) filters.name = { $ilike: `%${escapeLikePattern(term)}%` }
      }
      return filters
    },
  },
  hooks: {
    afterList: async (payload, ctx) => {
      const items = Array.isArray(payload?.items) ? payload.items as Array<Record<string, unknown>> : []
      const ids = items.map((item) => typeof item.id === 'string' ? item.id : '').filter(Boolean)
      if (ids.length === 0) return
      const em = (ctx.container.resolve('em') as EntityManager).fork()
      const templateTasks = await em.find(ProjectTemplateTask, { projectTemplate: { $in: ids }, deletedAt: null }, { populate: ['projectTemplate'] })
      const counts = new Map<string, number>()
      for (const task of templateTasks) {
        const templateId = (task.projectTemplate as ProjectTemplate).id
        counts.set(templateId, (counts.get(templateId) ?? 0) + 1)
      }
      for (const item of items) {
        const id = typeof item.id === 'string' ? item.id : ''
        item.taskTemplateCount = counts.get(id) ?? 0
      }
    },
  },
  actions: {
    create: {
      commandId: 'projects.project_templates.create',
      schema: rawBodySchema,
      mapInput: async ({ raw, ctx }) => {
        const { translate } = await resolveTranslations()
        return parseScopedCommandInput(projectTemplateCreateSchema, raw ?? {}, ctx, translate)
      },
      response: ({ result }) => ({ id: result?.templateId ?? null }),
      status: 201,
    },
    update: {
      commandId: 'projects.project_templates.update',
      schema: rawBodySchema,
      mapInput: async ({ raw, ctx }) => {
        const { translate } = await resolveTranslations()
        return parseScopedCommandInput(projectTemplateUpdateSchema, raw ?? {}, ctx, translate)
      },
      response: () => ({ ok: true }),
    },
    delete: {
      commandId: 'projects.project_templates.delete',
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

const projectTemplateListItemSchema = z.object({
  id: z.string().uuid().nullable().optional(),
  organization_id: z.string().uuid().nullable().optional(),
  tenant_id: z.string().uuid().nullable().optional(),
  name: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  is_active: z.boolean().nullable().optional(),
  taskTemplateCount: z.number().nullable().optional(),
  created_at: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
})

export const openApi = createProjectsCrudOpenApi({
  resourceName: 'Project template',
  pluralName: 'Project templates',
  querySchema: listSchema,
  listResponseSchema: createPagedListResponseSchema(projectTemplateListItemSchema),
  create: {
    schema: projectTemplateCreateSchema,
    description: 'Creates a reusable project template.',
  },
  update: {
    schema: projectTemplateUpdateSchema,
    responseSchema: defaultOkResponseSchema,
    description: 'Updates a project template by id.',
  },
  del: {
    schema: z.object({ id: z.string().uuid() }),
    responseSchema: defaultOkResponseSchema,
    description: 'Soft-deletes a project template by id.',
  },
})
