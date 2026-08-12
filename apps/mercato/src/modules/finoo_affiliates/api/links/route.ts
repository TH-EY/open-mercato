import { z } from 'zod'
import { makeCrudRoute } from '@open-mercato/shared/lib/crud/factory'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { FinooAffiliateLink } from '../../data/entities'
import { finooAffiliateLinkCreateSchema, finooAffiliateLinkUpdateSchema } from '../../data/validators'

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  sortField: z.enum(['createdAt', 'updatedAt', 'label', 'isActive']).default('createdAt'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
  withDeleted: z.coerce.boolean().default(false),
})

const rawBodySchema = z.object({}).passthrough()

const crud = makeCrudRoute({
  metadata: {
    GET: { requireAuth: true, requireFeatures: ['finoo_affiliates.view'] },
    POST: { requireAuth: true, requireFeatures: ['finoo_affiliates.manage'] },
    PUT: { requireAuth: true, requireFeatures: ['finoo_affiliates.manage'] },
    DELETE: { requireAuth: true, requireFeatures: ['finoo_affiliates.manage'] },
  },
  orm: {
    entity: FinooAffiliateLink,
    idField: 'id',
    orgField: 'organizationId',
    tenantField: 'tenantId',
    softDeleteField: 'deletedAt',
  },
  indexer: { entityType: 'finoo_affiliates:finoo_affiliate_link' },
  list: {
    schema: querySchema,
    entityId: 'finoo_affiliates:finoo_affiliate_link',
    fields: [
      'id',
      'affiliate_user_id',
      'code',
      'label',
      'destination_url',
      'is_active',
      'organization_id',
      'tenant_id',
      'created_at',
      'updated_at',
    ],
    sortFieldMap: {
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      label: 'label',
      isActive: 'is_active',
    },
  },
  actions: {
    create: {
      commandId: 'finoo_affiliates.links.create',
      schema: rawBodySchema,
      mapInput: ({ raw }) => finooAffiliateLinkCreateSchema.parse(raw),
      response: ({ result }) => ({ id: result?.id ?? null, code: result?.code ?? null }),
      status: 201,
    },
    update: {
      commandId: 'finoo_affiliates.links.update',
      schema: rawBodySchema,
      mapInput: ({ raw }) => finooAffiliateLinkUpdateSchema.parse(raw),
      response: ({ result }) => ({ id: result?.id ?? null, updatedAt: result?.updatedAt?.toISOString() ?? null }),
    },
    delete: {
      commandId: 'finoo_affiliates.links.delete',
      schema: rawBodySchema,
      mapInput: ({ raw }) => z.object({ id: z.string().uuid() }).parse(raw),
      response: () => ({ ok: true }),
    },
  },
})

export const metadata = crud.metadata
export const GET = crud.GET
export const POST = crud.POST
export const PUT = crud.PUT
export const DELETE = crud.DELETE

const linkResponseSchema = z.object({
  id: z.string().uuid(),
  affiliate_user_id: z.string().uuid(),
  code: z.string(),
  label: z.string(),
  destination_url: z.string().url(),
  is_active: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
}).passthrough()

export const openApi: OpenApiRouteDoc = {
  tag: 'Finoo Affiliates',
  methods: {
    GET: {
      summary: 'List Finoo affiliate links',
      query: querySchema,
      responses: [{ status: 200, description: 'Paginated affiliate links', schema: z.object({ items: z.array(linkResponseSchema), total: z.number() }).passthrough() }],
    },
    POST: {
      summary: 'Create a Finoo affiliate link',
      requestBody: { schema: finooAffiliateLinkCreateSchema },
      responses: [{ status: 201, description: 'Affiliate link created', schema: z.object({ id: z.string().uuid(), code: z.string() }) }],
    },
    PUT: {
      summary: 'Update a Finoo affiliate link',
      requestBody: { schema: finooAffiliateLinkUpdateSchema },
      responses: [{ status: 200, description: 'Affiliate link updated', schema: z.object({ id: z.string().uuid(), updatedAt: z.string() }) }],
    },
    DELETE: {
      summary: 'Delete a Finoo affiliate link',
      requestBody: { schema: z.object({ id: z.string().uuid() }) },
      responses: [{ status: 200, description: 'Affiliate link deleted', schema: z.object({ ok: z.literal(true) }) }],
    },
  },
}
