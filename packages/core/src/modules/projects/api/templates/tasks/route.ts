import { z } from 'zod'
import { makeCrudRoute } from '@open-mercato/shared/lib/crud/factory'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { resolveCrudRecordId, parseScopedCommandInput } from '@open-mercato/shared/lib/api/scoped'
import { escapeLikePattern } from '@open-mercato/shared/lib/db/escapeLikePattern'
import { ProjectTemplateTask } from '../../../data/entities'
import { projectTemplateTaskCreateSchema, projectTemplateTaskUpdateSchema } from '../../../data/validators'
import { projectTaskStatuses } from '../../../lib/statuses'
import { E } from '#generated/entities.ids.generated'
import { createPagedListResponseSchema, createProjectsCrudOpenApi, defaultOkResponseSchema } from '../../openapi'

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
    pageSize: z.coerce.number().min(1).max(100).default(100),
    ids: z.string().optional(),
    search: z.string().optional(),
    projectTemplateId: z.string().uuid().optional(),
    taskTemplateId: z.string().uuid().optional(),
    status: z.enum(projectTaskStatuses).optional(),
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
    entity: ProjectTemplateTask,
    idField: 'id',
    orgField: 'organizationId',
    tenantField: 'tenantId',
    softDeleteField: 'deletedAt',
  },
  indexer: { entityType: E.projects.project_template_task },
  list: {
    schema: listSchema,
    entityId: E.projects.project_template_task,
    fields: [
      'id',
      'organization_id',
      'tenant_id',
      'project_template_id',
      'task_template_id',
      'name',
      'status',
      'description',
      'owner_user_id',
      'due_in_days',
      'position',
      'created_at',
      'updated_at',
    ],
    sortFieldMap: {
      name: 'name',
      status: 'status',
      position: 'position',
      dueInDays: 'due_in_days',
      updatedAt: 'updated_at',
    },
    buildFilters: async (query) => {
      const filters: Record<string, unknown> = {}
      const ids = parseIds(query.ids)
      if (ids.length) filters.id = { $in: ids }
      if (query.projectTemplateId) filters.project_template_id = query.projectTemplateId
      if (query.taskTemplateId) filters.task_template_id = query.taskTemplateId
      if (query.status) filters.status = query.status
      if (query.search) {
        const term = query.search.trim()
        if (term.length) filters.name = { $ilike: `%${escapeLikePattern(term)}%` }
      }
      return filters
    },
  },
  actions: {
    create: {
      commandId: 'projects.project_template_tasks.create',
      schema: rawBodySchema,
      mapInput: async ({ raw, ctx }) => {
        const { translate } = await resolveTranslations()
        return parseScopedCommandInput(projectTemplateTaskCreateSchema, raw ?? {}, ctx, translate)
      },
      response: ({ result }) => ({ id: result?.templateTaskId ?? null }),
      status: 201,
    },
    update: {
      commandId: 'projects.project_template_tasks.update',
      schema: rawBodySchema,
      mapInput: async ({ raw, ctx }) => {
        const { translate } = await resolveTranslations()
        return parseScopedCommandInput(projectTemplateTaskUpdateSchema, raw ?? {}, ctx, translate)
      },
      response: () => ({ ok: true }),
    },
    delete: {
      commandId: 'projects.project_template_tasks.delete',
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

const projectTemplateTaskListItemSchema = z.object({
  id: z.string().uuid().nullable().optional(),
  organization_id: z.string().uuid().nullable().optional(),
  tenant_id: z.string().uuid().nullable().optional(),
  project_template_id: z.string().uuid().nullable().optional(),
  task_template_id: z.string().uuid().nullable().optional(),
  name: z.string().nullable().optional(),
  status: z.enum(projectTaskStatuses).nullable().optional(),
  description: z.string().nullable().optional(),
  owner_user_id: z.string().uuid().nullable().optional(),
  due_in_days: z.number().nullable().optional(),
  position: z.number().nullable().optional(),
  created_at: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
})

export const openApi = createProjectsCrudOpenApi({
  resourceName: 'Project template task',
  pluralName: 'Project template tasks',
  querySchema: listSchema,
  listResponseSchema: createPagedListResponseSchema(projectTemplateTaskListItemSchema),
  create: {
    schema: projectTemplateTaskCreateSchema,
    description: 'Creates a task row inside a project template.',
  },
  update: {
    schema: projectTemplateTaskUpdateSchema,
    responseSchema: defaultOkResponseSchema,
    description: 'Updates a project template task by id.',
  },
  del: {
    schema: z.object({ id: z.string().uuid() }),
    responseSchema: defaultOkResponseSchema,
    description: 'Soft-deletes a project template task by id.',
  },
})
