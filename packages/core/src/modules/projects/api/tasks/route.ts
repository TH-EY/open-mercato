import { z } from 'zod'
import { makeCrudRoute } from '@open-mercato/shared/lib/crud/factory'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { resolveCrudRecordId, parseScopedCommandInput } from '@open-mercato/shared/lib/api/scoped'
import { escapeLikePattern } from '@open-mercato/shared/lib/db/escapeLikePattern'
import { ProjectTask } from '../../data/entities'
import { projectTaskCreateSchema, projectTaskUpdateSchema } from '../../data/validators'
import { projectTaskStatuses } from '../../lib/statuses'
import { E } from '#generated/entities.ids.generated'
import { createPagedListResponseSchema, createProjectsCrudOpenApi, defaultOkResponseSchema } from '../openapi'

const routeMetadata = {
  GET: { requireAuth: true, requireFeatures: ['projects.view'] },
  POST: { requireAuth: true, requireFeatures: ['projects.tasks.manage'] },
  PUT: { requireAuth: true, requireFeatures: ['projects.tasks.manage'] },
  DELETE: { requireAuth: true, requireFeatures: ['projects.tasks.manage'] },
}

export const metadata = routeMetadata

const rawBodySchema = z.object({}).passthrough()

const listSchema = z
  .object({
    page: z.coerce.number().min(1).default(1),
    pageSize: z.coerce.number().min(1).max(100).default(100),
    ids: z.string().optional(),
    search: z.string().optional(),
    projectId: z.string().uuid().optional(),
    status: z.enum(projectTaskStatuses).optional(),
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
    entity: ProjectTask,
    idField: 'id',
    orgField: 'organizationId',
    tenantField: 'tenantId',
    softDeleteField: 'deletedAt',
  },
  indexer: { entityType: E.projects.project_task },
  list: {
    schema: listSchema,
    entityId: E.projects.project_task,
    fields: [
      'id',
      'organization_id',
      'tenant_id',
      'project_id',
      'name',
      'status',
      'description',
      'owner_user_id',
      'deadline_at',
      'position',
      'created_at',
      'updated_at',
    ],
    sortFieldMap: {
      name: 'name',
      status: 'status',
      position: 'position',
      deadlineAt: 'deadline_at',
      updatedAt: 'updated_at',
    },
    buildFilters: async (query) => {
      const filters: Record<string, unknown> = {}
      const ids = parseIds(query.ids)
      if (ids.length) filters.id = { $in: ids }
      if (query.projectId) filters.project_id = query.projectId
      if (query.status) filters.status = query.status
      if (query.ownerUserId) filters.owner_user_id = query.ownerUserId
      if (query.search) {
        const term = query.search.trim()
        if (term.length) filters.name = { $ilike: `%${escapeLikePattern(term)}%` }
      }
      return filters
    },
  },
  actions: {
    create: {
      commandId: 'projects.tasks.create',
      schema: rawBodySchema,
      mapInput: async ({ raw, ctx }) => {
        const { translate } = await resolveTranslations()
        return parseScopedCommandInput(projectTaskCreateSchema, raw ?? {}, ctx, translate)
      },
      response: ({ result }) => ({ id: result?.taskId ?? null }),
      status: 201,
    },
    update: {
      commandId: 'projects.tasks.update',
      schema: rawBodySchema,
      mapInput: async ({ raw, ctx }) => {
        const { translate } = await resolveTranslations()
        return parseScopedCommandInput(projectTaskUpdateSchema, raw ?? {}, ctx, translate)
      },
      response: () => ({ ok: true }),
    },
    delete: {
      commandId: 'projects.tasks.delete',
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

const taskListItemSchema = z.object({
  id: z.string().uuid().nullable().optional(),
  organization_id: z.string().uuid().nullable().optional(),
  tenant_id: z.string().uuid().nullable().optional(),
  project_id: z.string().uuid().nullable().optional(),
  name: z.string().nullable().optional(),
  status: z.enum(projectTaskStatuses).nullable().optional(),
  description: z.string().nullable().optional(),
  owner_user_id: z.string().uuid().nullable().optional(),
  deadline_at: z.string().nullable().optional(),
  position: z.number().nullable().optional(),
  created_at: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
})

export const openApi = createProjectsCrudOpenApi({
  resourceName: 'Project task',
  pluralName: 'Project tasks',
  querySchema: listSchema,
  listResponseSchema: createPagedListResponseSchema(taskListItemSchema),
  create: {
    schema: projectTaskCreateSchema,
    description: 'Creates a task inside a project.',
  },
  update: {
    schema: projectTaskUpdateSchema,
    responseSchema: defaultOkResponseSchema,
    description: 'Updates a project task by id.',
  },
  del: {
    schema: z.object({ id: z.string().uuid() }),
    responseSchema: defaultOkResponseSchema,
    description: 'Soft-deletes a project task by id.',
  },
})
