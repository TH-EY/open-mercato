import { z } from 'zod'
import { NextResponse } from 'next/server'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import { finooIdentityAuditListSchema } from '../../../../data/validators'
import type { FinooIdentityService } from '../../../../lib/service'

export const metadata = { GET: { requireAuth: true } }
const noStoreHeaders = { 'Cache-Control': 'private, no-store' }

const paramsSchema = z.object({ personId: z.string().uuid() })
const auditItemSchema = z.object({
  id: z.string().uuid(),
  actorUserId: z.string().uuid().nullable(),
  actorKind: z.enum(['user', 'system']),
  operation: z.string(),
  outcome: z.enum(['allowed', 'denied']),
  changedFields: z.array(z.string()).nullable(),
  createdAt: z.string().datetime({ offset: true }),
})

export async function GET(
  request: Request,
  context: { params: Promise<{ personId: string }> },
): Promise<Response> {
  const auth = await getAuthFromRequest(request)
  if (!auth?.sub || !auth.tenantId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: noStoreHeaders })
  const parsedParams = paramsSchema.safeParse(await context.params)
  const query = finooIdentityAuditListSchema.safeParse(Object.fromEntries(new URL(request.url).searchParams.entries()))
  if (!parsedParams.success || !query.success) {
    return NextResponse.json({ error: 'invalid_scope' }, { status: 422, headers: noStoreHeaders })
  }
  const container = await createRequestContainer()
  const organizationScope = await resolveOrganizationScopeForRequest({ container, auth, request })
  const organizationId = organizationScope.selectedId ?? auth.orgId
  if (!organizationId) return NextResponse.json({ error: 'invalid_scope' }, { status: 422, headers: noStoreHeaders })
  try {
    const service = container.resolve('finooIdentityService') as FinooIdentityService
    const result = await service.listAuditForAuthorizedActor({
      scope: {
        actorUserId: auth.sub,
        tenantId: auth.tenantId,
        organizationId,
        personId: parsedParams.data.personId,
      },
      ...query.data,
    })
    return NextResponse.json(result, { headers: noStoreHeaders })
  } catch (error) {
    if (isCrudHttpError(error)) return NextResponse.json(error.body, { status: error.status, headers: noStoreHeaders })
    throw error
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'FINOO Identity Data',
  summary: 'List value-free access audit entries for one Person',
  methods: {
    GET: {
      summary: 'List restricted identity audit entries',
      responses: [{
        status: 200,
        description: 'Paginated identity audit metadata',
        schema: z.object({
          items: z.array(auditItemSchema),
          page: z.number().int(),
          pageSize: z.number().int(),
          total: z.number().int(),
        }),
      }],
    },
  },
}
