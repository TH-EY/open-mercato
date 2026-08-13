import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { runRouteMutationGuards } from '@open-mercato/shared/lib/crud/route-mutation-guard'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import type { ProgressService } from '@open-mercato/core/modules/progress/lib/progressService'
import { finooPayoutConfirmSchema } from '../../../data/validators'
import { validatePayoutConfirmation } from '../../../lib/payouts'
import { getFinooPayoutQueue } from '../../../lib/payoutQueue'

export const metadata = { POST: { requireAuth: true, requireFeatures: ['finoo_affiliates.payouts.manage'] } }

export async function POST(request: Request): Promise<Response> {
  const auth = await getAuthFromRequest(request)
  if (!auth?.tenantId || !auth.sub) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const parsed = finooPayoutConfirmSchema.safeParse(await readJsonSafe(request, null))
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
      resourceKind: 'finoo_affiliates.affiliate_payout',
      resourceId: parsed.data.paymentReference,
      operation: 'create',
      mutationPayload: parsed.data,
    },
  })
  if (!guarded.ok) return guarded.response
  try {
    const input = finooPayoutConfirmSchema.parse(guarded.modifiedPayload ?? parsed.data)
    const validation = await validatePayoutConfirmation(container.resolve('em') as EntityManager, input, scope)
    if (validation.payout) {
      await guarded.runAfterSuccess()
      return NextResponse.json({ payoutId: validation.payout.id, paymentReference: validation.payout.paymentReference })
    }
    const { translate } = await resolveTranslations()
    const progressService = container.resolve('progressService') as ProgressService
    const progressJob = await progressService.createJob({
      jobType: 'finoo_affiliates.payout.create',
      name: translate('finooAffiliates.payouts.progressName', 'Create affiliate payout'),
      description: translate('finooAffiliates.payouts.progressDescription', 'Recording confirmed affiliate payout'),
      totalCount: input.transactions.length,
      cancellable: false,
      meta: { paymentReference: input.paymentReference },
    }, { ...scope, userId: auth.sub })
    try {
      await getFinooPayoutQueue().enqueue({
        progressJobId: progressJob.id,
        paymentReference: input.paymentReference,
        affiliateUpdatedAt: input.affiliateUpdatedAt,
        transactions: input.transactions,
        ...scope,
        userId: auth.sub,
      })
    } catch (error) {
      await progressService.failJob(progressJob.id, { errorMessage: 'Affiliate payout could not be queued' }, { ...scope, userId: auth.sub })
      throw error
    }
    await guarded.runAfterSuccess()
    return NextResponse.json({ progressJobId: progressJob.id, paymentReference: input.paymentReference }, { status: 202 })
  } catch (error) {
    if (isCrudHttpError(error)) return NextResponse.json(error.body, { status: error.status })
    throw error
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Finoo Affiliates',
  methods: {
    POST: {
      summary: 'Confirm and enqueue an exact affiliate payout',
      requestBody: { schema: finooPayoutConfirmSchema },
      responses: [
        { status: 202, description: 'Payout queued', schema: z.object({ progressJobId: z.string().uuid(), paymentReference: z.string() }) },
        { status: 200, description: 'Payout already completed', schema: z.object({ payoutId: z.string().uuid(), paymentReference: z.string() }) },
      ],
    },
  },
}
