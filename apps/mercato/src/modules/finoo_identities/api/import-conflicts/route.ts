import { z } from 'zod'
import { NextResponse } from 'next/server'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import { finooIdentityConflictListSchema } from '../../data/validators'
import type { FinooIdentityService } from '../../lib/service'

export const metadata = { GET: { requireAuth: true } }
const noStoreHeaders = { 'Cache-Control': 'private, no-store' }

const identityValuesSchema = z.object({
  pesel: z.string().nullable(),
  documentType: z.string().nullable(),
  issuingCountryCode: z.string().nullable(),
  documentNumber: z.string().nullable(),
  issuedOn: z.string().nullable(),
  expiresOn: z.string().nullable(),
})

export async function GET(request: Request): Promise<Response> {
  const auth = await getAuthFromRequest(request)
  if (!auth?.sub || !auth.tenantId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const query = finooIdentityConflictListSchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams.entries()),
  )
  if (!query.success) return NextResponse.json({ error: 'invalid_scope' }, { status: 422 })
  const container = await createRequestContainer()
  const organizationScope = await resolveOrganizationScopeForRequest({ container, auth, request })
  const organizationId = organizationScope.selectedId ?? auth.orgId
  if (!organizationId) return NextResponse.json({ error: 'invalid_scope' }, { status: 422 })
  try {
    const service = container.resolve('finooIdentityService') as FinooIdentityService
    const result = await service.listConflictsForAuthorizedActor({
      scope: {
        actorUserId: auth.sub,
        tenantId: auth.tenantId,
        organizationId,
        personId: query.data.personId,
      },
      page: query.data.page,
      pageSize: query.data.pageSize,
    })
    return NextResponse.json(result, { headers: noStoreHeaders })
  } catch (error) {
    if (isCrudHttpError(error)) {
      return NextResponse.json(error.body, { status: error.status, headers: noStoreHeaders })
    }
    throw error
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'FINOO Identity Data',
  summary: 'List open identity import conflicts for one Person',
  methods: {
    GET: {
      summary: 'List restricted identity import conflicts',
      responses: [{
        status: 200,
        description: 'Paginated decrypted conflicts for an authorized actor',
        schema: z.object({
          items: z.array(z.object({
            id: z.string().uuid(),
            sourceModule: z.string(),
            sourceRecordId: z.string().uuid(),
            changedFields: z.array(z.string()),
            state: z.literal('open'),
            current: identityValuesSchema.extend({ updatedAt: z.string().datetime({ offset: true }) }),
            candidate: identityValuesSchema,
            createdAt: z.string().datetime({ offset: true }),
            updatedAt: z.string().datetime({ offset: true }),
          })),
          page: z.number().int(),
          pageSize: z.number().int(),
          total: z.number().int(),
        }),
      }],
    },
  },
}
