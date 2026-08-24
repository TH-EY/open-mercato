import { z } from 'zod'
import { NextResponse } from 'next/server'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import type { FinooIdentityService } from '../../../../lib/service'

export const metadata = { GET: { requireAuth: true } }

const paramsSchema = z.object({ personId: z.string().uuid() })
const noStoreHeaders = { 'Cache-Control': 'private, no-store' }
const fieldStatusSchema = z.enum(['complete', 'missing', 'not_applicable'])
const responseSchema = z.object({
  isComplete: z.boolean(),
  statuses: z.object({
    pesel: fieldStatusSchema,
    documentType: fieldStatusSchema,
    issuingCountryCode: fieldStatusSchema,
    documentNumber: fieldStatusSchema,
    issuedOn: fieldStatusSchema,
    expiresOn: fieldStatusSchema,
  }),
})

export async function GET(
  request: Request,
  context: { params: Promise<{ personId: string }> },
): Promise<Response> {
  const auth = await getAuthFromRequest(request)
  if (!auth?.sub || !auth.tenantId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: noStoreHeaders })
  }
  const params = paramsSchema.safeParse(await context.params)
  if (!params.success) {
    return NextResponse.json({ error: 'invalid_scope' }, { status: 422, headers: noStoreHeaders })
  }
  const container = await createRequestContainer()
  const organizationScope = await resolveOrganizationScopeForRequest({ container, auth, request })
  const organizationId = organizationScope.selectedId ?? auth.orgId
  if (!organizationId) {
    return NextResponse.json({ error: 'invalid_scope' }, { status: 422, headers: noStoreHeaders })
  }
  const service = container.resolve('finooIdentityService') as FinooIdentityService
  try {
    const result = await service.readStatusForPersonViewer({
      actorUserId: auth.sub,
      tenantId: auth.tenantId,
      organizationId,
      personId: params.data.personId,
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
  summary: 'Read neutral identity completeness for one visible Person',
  methods: {
    GET: {
      summary: 'Read identity field statuses without protected values',
      responses: [{ status: 200, description: 'Neutral identity completeness statuses', schema: responseSchema }],
    },
  },
}
