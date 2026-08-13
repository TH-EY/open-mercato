import { z } from 'zod'
import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandBus } from '@open-mercato/shared/lib/commands'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { bridgeLegacyGuard, runMutationGuards } from '@open-mercato/shared/lib/crud/mutation-guard-registry'
import { isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import type { EnsureAffiliateInvitationOutput } from '../../../commands/affiliate-memberships'

const inputSchema = z.object({ invitationId: z.string().uuid() })

export const metadata = { POST: { requireAuth: true, requireFeatures: ['finoo_affiliates.manage'] } }

export async function POST(request: Request): Promise<Response> {
  const auth = await getAuthFromRequest(request)
  if (!auth?.tenantId || !auth.sub) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const parsed = inputSchema.safeParse(await readJsonSafe(request, null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  const container = await createRequestContainer()
  const organizationScope = await resolveOrganizationScopeForRequest({ container, auth, request })
  const organizationId = organizationScope.selectedId ?? auth.orgId
  if (!organizationId) return NextResponse.json({ error: 'Organization is required' }, { status: 400 })
  const scope = { tenantId: auth.tenantId, organizationId }
  const guard = bridgeLegacyGuard(container)
  let callbacks: Awaited<ReturnType<typeof runMutationGuards>>['afterSuccessCallbacks'] = []
  if (guard) {
    const guarded = await runMutationGuards([guard], {
      ...scope,
      userId: auth.sub,
      resourceKind: 'finoo_affiliates.affiliate',
      resourceId: parsed.data.invitationId,
      operation: 'create',
      requestMethod: request.method,
      requestHeaders: request.headers,
      mutationPayload: parsed.data,
    }, { userFeatures: Array.isArray(auth.features) ? auth.features : [] })
    if (!guarded.ok) return NextResponse.json(guarded.errorBody ?? { error: 'Mutation rejected' }, { status: guarded.errorStatus ?? 422 })
    callbacks = guarded.afterSuccessCallbacks
  }
  const commandBus = container.resolve('commandBus') as CommandBus
  try {
    const { result } = await commandBus.execute<Record<string, unknown>, EnsureAffiliateInvitationOutput>(
      'finoo_affiliates.affiliate.ensure_invitation',
      {
        input: { invitationId: parsed.data.invitationId, ...scope },
        ctx: {
          container,
          auth,
          organizationScope,
          selectedOrganizationId: organizationId,
          organizationIds: organizationScope.allowedIds,
          request,
        },
      },
    )
    for (const callback of callbacks) {
      await callback.guard.afterSuccess?.({
        ...scope,
        userId: auth.sub,
        resourceKind: 'finoo_affiliates.affiliate',
        resourceId: result.affiliate.id,
        operation: 'create',
        requestMethod: request.method,
        requestHeaders: request.headers,
        metadata: callback.metadata ?? null,
      })
    }
    const trackedUrl = new URL(`/api/finoo_affiliates/r/${result.affiliate.code}`, request.url).toString()
    return NextResponse.json({
      ok: true,
      affiliate: {
        id: result.affiliate.id,
        code: result.affiliate.code,
        isActive: result.affiliate.isActive,
        trackedUrl,
      },
    }, { status: result.created ? 201 : 200 })
  } catch (error) {
    if (isCrudHttpError(error)) return NextResponse.json(error.body, { status: error.status })
    throw error
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Finoo Affiliates',
  methods: {
    POST: {
      summary: 'Ensure Finoo membership for a delivered affiliate invitation',
      requestBody: { schema: inputSchema },
      responses: [{ status: 201, description: 'Affiliate membership reserved', schema: z.object({ ok: z.literal(true), affiliate: z.object({ id: z.string().uuid(), code: z.string(), isActive: z.boolean(), trackedUrl: z.string().url() }) }) }],
    },
  },
}
