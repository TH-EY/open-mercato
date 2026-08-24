import { z } from 'zod'
import { NextResponse } from 'next/server'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { runRouteMutationGuards } from '@open-mercato/shared/lib/crud/route-mutation-guard'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import { finooIdentityConflictResolutionSchema } from '../../../../data/validators'
import type { FinooIdentityService } from '../../../../lib/service'

export const metadata = { POST: { requireAuth: true } }

const paramsSchema = z.object({ id: z.string().uuid() })
const noStoreHeaders = { 'Cache-Control': 'private, no-store' }
const fieldStatusSchema = z.enum(['complete', 'missing', 'not_applicable'])
const resolutionResponseSchema = z.object({
  conflictId: z.string().uuid(),
  identityId: z.string().uuid(),
  state: z.enum(['resolved', 'dismissed']),
  isComplete: z.boolean(),
  statuses: z.object({
    pesel: fieldStatusSchema,
    documentType: fieldStatusSchema,
    issuingCountryCode: fieldStatusSchema,
    documentNumber: fieldStatusSchema,
    issuedOn: fieldStatusSchema,
    expiresOn: fieldStatusSchema,
  }),
  identityUpdatedAt: z.string().datetime({ offset: true }),
  conflictUpdatedAt: z.string().datetime({ offset: true }),
})

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await getAuthFromRequest(request)
  if (!auth?.sub || !auth.tenantId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const params = paramsSchema.safeParse(await context.params)
  const input = finooIdentityConflictResolutionSchema.safeParse(await readJsonSafe(request, null))
  if (!params.success || !input.success) {
    return NextResponse.json({ error: 'identity_validation_failed' }, { status: 422 })
  }
  const container = await createRequestContainer()
  const organizationScope = await resolveOrganizationScopeForRequest({ container, auth, request })
  const organizationId = organizationScope.selectedId ?? auth.orgId
  if (!organizationId) return NextResponse.json({ error: 'invalid_scope' }, { status: 422 })
  const service = container.resolve('finooIdentityService') as FinooIdentityService
  const actorScope = {
    actorUserId: auth.sub,
    tenantId: auth.tenantId,
    organizationId,
  }
  try {
    await service.authorizeConflictManagementActor({
      scope: actorScope,
      conflictId: params.data.id,
      operation: input.data.action === 'replace' ? 'resolve_conflict' : 'dismiss_conflict',
    })
  } catch (error) {
    if (isCrudHttpError(error)) {
      return NextResponse.json(error.body, { status: error.status, headers: noStoreHeaders })
    }
    throw error
  }
  const guarded = await runRouteMutationGuards({
    container,
    req: request,
    auth: {
      userId: auth.sub,
      tenantId: auth.tenantId,
      organizationId,
    },
    input: {
      resourceKind: 'finoo_identities.import_conflict',
      resourceId: params.data.id,
      operation: 'update',
      mutationPayload: { action: input.data.action },
    },
  })
  if (!guarded.ok) {
    guarded.response.headers.set('Cache-Control', noStoreHeaders['Cache-Control'])
    return guarded.response
  }
  try {
    const result = await service.resolveConflictForAuthorizedActor({
      scope: actorScope,
      conflictId: params.data.id,
      input: input.data,
    })
    await guarded.runAfterSuccess()
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
  summary: 'Resolve or dismiss one restricted identity import conflict',
  methods: {
    POST: {
      summary: 'Resolve an identity import conflict',
      requestBody: { contentType: 'application/json', schema: finooIdentityConflictResolutionSchema },
      responses: [{ status: 200, description: 'Safe conflict resolution metadata', schema: resolutionResponseSchema }],
    },
  },
}
