import { z } from 'zod'
import { NextResponse } from 'next/server'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { runRouteMutationGuards } from '@open-mercato/shared/lib/crud/route-mutation-guard'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import { finooIdentityInputSchema } from '../../../data/validators'
import type { FinooIdentityService } from '../../../lib/service'

export const metadata = {
  GET: { requireAuth: true },
  PUT: { requireAuth: true },
}

const paramsSchema = z.object({ personId: z.string().uuid() })
const noStoreHeaders = { 'Cache-Control': 'private, no-store' }
const fieldStatusSchema = z.enum(['complete', 'missing', 'not_applicable'])
const statusesSchema = z.object({
  pesel: fieldStatusSchema,
  documentType: fieldStatusSchema,
  issuingCountryCode: fieldStatusSchema,
  documentNumber: fieldStatusSchema,
  issuedOn: fieldStatusSchema,
  expiresOn: fieldStatusSchema,
})
const writeResponseSchema = z.object({
  id: z.string().uuid(),
  isComplete: z.boolean(),
  statuses: statusesSchema,
  updatedAt: z.string().datetime({ offset: true }),
})
const readResponseSchema = writeResponseSchema.extend({
  pesel: z.string().nullable(),
  documentType: z.string().nullable(),
  issuingCountryCode: z.string().nullable(),
  documentNumber: z.string().nullable(),
  issuedOn: z.string().nullable(),
  expiresOn: z.string().nullable(),
})

export async function GET(
  request: Request,
  context: { params: Promise<{ personId: string }> },
): Promise<Response> {
  const auth = await getAuthFromRequest(request)
  if (!auth?.sub || !auth.tenantId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: noStoreHeaders })
  }
  const parsedParams = paramsSchema.safeParse(await context.params)
  if (!parsedParams.success) {
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
    const result = await service.readForAuthorizedActor({
      actorUserId: auth.sub,
      tenantId: auth.tenantId,
      organizationId,
      personId: parsedParams.data.personId,
    })
    return NextResponse.json(result, { headers: noStoreHeaders })
  } catch (error) {
    if (isCrudHttpError(error)) {
      return NextResponse.json(error.body, { status: error.status, headers: noStoreHeaders })
    }
    throw error
  }
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ personId: string }> },
): Promise<Response> {
  const auth = await getAuthFromRequest(request)
  if (!auth?.sub || !auth.tenantId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: noStoreHeaders })
  }
  const parsedParams = paramsSchema.safeParse(await context.params)
  if (!parsedParams.success) {
    return NextResponse.json({ error: 'invalid_scope' }, { status: 422, headers: noStoreHeaders })
  }
  const container = await createRequestContainer()
  const organizationScope = await resolveOrganizationScopeForRequest({ container, auth, request })
  const organizationId = organizationScope.selectedId ?? auth.orgId
  if (!organizationId) {
    return NextResponse.json({ error: 'invalid_scope' }, { status: 422, headers: noStoreHeaders })
  }
  const service = container.resolve('finooIdentityService') as FinooIdentityService
  const actorScope = {
    actorUserId: auth.sub,
    tenantId: auth.tenantId,
    organizationId,
    personId: parsedParams.data.personId,
  }
  try {
    await service.authorizeIdentityManagementActor(actorScope)
  } catch (error) {
    if (isCrudHttpError(error)) {
      return NextResponse.json(error.body, { status: error.status, headers: noStoreHeaders })
    }
    throw error
  }
  const parsedInput = finooIdentityInputSchema.safeParse(await readJsonSafe(request, null))
  if (!parsedInput.success) {
    return NextResponse.json({
      error: 'identity_validation_failed',
      fields: parsedInput.error.flatten().fieldErrors,
    }, { status: 422, headers: noStoreHeaders })
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
      resourceKind: 'finoo_identities.identity',
      resourceId: parsedParams.data.personId,
      operation: 'update',
      mutationPayload: { changedFields: ['pesel', 'documentType', 'issuingCountryCode', 'documentNumber', 'issuedOn', 'expiresOn'] },
    },
  })
  if (!guarded.ok) {
    guarded.response.headers.set('Cache-Control', noStoreHeaders['Cache-Control'])
    return guarded.response
  }
  try {
    const result = await service.upsertForAuthorizedActor({
      scope: actorScope,
      input: parsedInput.data,
      request,
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
  summary: 'Read or update restricted identity data for one Person',
  methods: {
    GET: {
      summary: 'Read restricted identity data',
      responses: [{ status: 200, description: 'Authorized identity data', schema: readResponseSchema }],
    },
    PUT: {
      summary: 'Create or update restricted identity data',
      requestBody: { contentType: 'application/json', schema: finooIdentityInputSchema },
      responses: [{ status: 200, description: 'Safe identity write result', schema: writeResponseSchema }],
    },
  },
}
