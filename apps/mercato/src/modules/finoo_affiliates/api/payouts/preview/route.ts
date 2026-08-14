import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { runRouteMutationGuards } from '@open-mercato/shared/lib/crud/route-mutation-guard'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import { finooPayoutPreviewSchema } from '../../../data/validators'
import { createPayoutPreview } from '../../../lib/payouts'

export const metadata = { POST: { requireAuth: true, requireFeatures: ['finoo_affiliates.payouts.manage'] } }

export async function POST(request: Request): Promise<Response> {
  const auth = await getAuthFromRequest(request)
  if (!auth?.tenantId || !auth.sub) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const parsed = finooPayoutPreviewSchema.safeParse(await readJsonSafe(request, null))
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 })
  const container = await createRequestContainer()
  const organizationScope = await resolveOrganizationScopeForRequest({ container, auth, request })
  const organizationId = organizationScope.selectedId ?? auth.orgId
  if (!organizationId) return NextResponse.json({ error: 'Organization is required' }, { status: 400 })
  const scope = { tenantId: auth.tenantId, organizationId }
  const guarded = await runRouteMutationGuards({
    container,
    req: request,
    auth: { userId: auth.sub, ...scope },
    input: {
      resourceKind: 'finoo_affiliates.payout_preview',
      resourceId: parsed.data.transactions.map((item) => item.id).sort().join(','),
      operation: 'create',
      mutationPayload: parsed.data,
    },
  })
  if (!guarded.ok) return guarded.response
  try {
    const input = finooPayoutPreviewSchema.parse(guarded.modifiedPayload ?? parsed.data)
    const result = await createPayoutPreview(container.resolve('em') as EntityManager, input.transactions, scope)
    await guarded.runAfterSuccess()
    return NextResponse.json(result)
  } catch (error) {
    if (isCrudHttpError(error)) return NextResponse.json(error.body, { status: error.status })
    throw error
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Finoo Affiliates',
  methods: {
    POST: {
      summary: 'Create an exact affiliate payout preview',
      requestBody: { schema: finooPayoutPreviewSchema },
      responses: [{ status: 200, description: 'Bound payout preview', schema: z.object({
        paymentReference: z.string(), affiliateId: z.string().uuid(), affiliateEmail: z.string().email(), affiliateUpdatedAt: z.string().datetime(),
        accountHolderName: z.string(), accountNumber: z.string(), amount: z.string().regex(/^\d+$/), currency: z.literal('PLN'),
        selectedCount: z.number().int(), transactions: finooPayoutPreviewSchema.shape.transactions, expiresAt: z.string().datetime(),
      }) }],
    },
  },
}
