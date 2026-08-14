import { z } from 'zod'
import { NextResponse } from 'next/server'
import type { CommandBus } from '@open-mercato/shared/lib/commands'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { runRouteMutationGuards } from '@open-mercato/shared/lib/crud/route-mutation-guard'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import type { FinooAffiliateTransaction } from '../../../../data/entities'
import { finooAffiliateTransactionTransitionSchema } from '../../../../data/validators'

export const metadata = { POST: { requireAuth: true, requireFeatures: ['finoo_affiliates.manage'] } }

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = await getAuthFromRequest(request)
  if (!auth?.tenantId || !auth.sub) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const id = z.string().uuid().safeParse((await context.params).id)
  const body = finooAffiliateTransactionTransitionSchema.safeParse(await readJsonSafe(request, null))
  if (!id.success || !body.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 })
  const container = await createRequestContainer()
  const organizationScope = await resolveOrganizationScopeForRequest({ container, auth, request })
  const organizationId = organizationScope.selectedId ?? auth.orgId
  if (!organizationId) return NextResponse.json({ error: 'Organization is required' }, { status: 400 })
  const guarded = await runRouteMutationGuards({
    container,
    req: request,
    auth: { userId: auth.sub, tenantId: auth.tenantId, organizationId },
    input: {
      resourceKind: 'finoo_affiliates.affiliate_transaction',
      resourceId: id.data,
      operation: 'update',
      mutationPayload: body.data,
    },
  })
  if (!guarded.ok) return guarded.response
  const input = finooAffiliateTransactionTransitionSchema.parse(guarded.modifiedPayload ?? body.data)
  try {
    const { result } = await (container.resolve('commandBus') as CommandBus).execute<Record<string, unknown>, FinooAffiliateTransaction>(
      'finoo_affiliates.transaction.transition',
      {
        input: { id: id.data, ...input },
        ctx: {
          container,
          auth: auth as never,
          organizationScope,
          selectedOrganizationId: organizationId,
          organizationIds: [organizationId],
          request,
        },
      },
    )
    await guarded.runAfterSuccess()
    return NextResponse.json({
      id: result.id,
      commissionStatus: result.commissionStatus,
      updatedAt: result.updatedAt.toISOString(),
    })
  } catch (error) {
    if (isCrudHttpError(error)) return NextResponse.json(error.body, { status: error.status })
    throw error
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Finoo Affiliates',
  methods: {
    POST: {
      summary: 'Transition a Finoo affiliate transaction',
      requestBody: { schema: finooAffiliateTransactionTransitionSchema },
      responses: [
        { status: 200, description: 'Updated transaction', schema: z.object({ id: z.string().uuid(), commissionStatus: z.enum(['processing', 'approved', 'rejected']), updatedAt: z.string().datetime() }) },
        { status: 409, description: 'Invalid or stale transition' },
      ],
    },
  },
}
