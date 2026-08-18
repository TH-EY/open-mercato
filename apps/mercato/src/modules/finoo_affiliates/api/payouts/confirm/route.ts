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
import { finooPayoutConfirmSchema, normalizePayoutConfirmGroups, payoutConfirmBatchId } from '../../../data/validators'
import { validatePayoutBatchConfirmation } from '../../../lib/payouts'
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
  const parsedGroups = normalizePayoutConfirmGroups(parsed.data)
  const guarded = await runRouteMutationGuards({
    container,
    req: request,
    auth: { userId: auth.sub, ...scope },
    input: {
      resourceKind: 'finoo_affiliates.affiliate_payout',
      resourceId: parsedGroups.map((group) => group.paymentReference).sort().join(','),
      operation: 'create',
      mutationPayload: parsed.data,
    },
  })
  if (!guarded.ok) return guarded.response
  try {
    const input = finooPayoutConfirmSchema.parse(guarded.modifiedPayload ?? parsed.data)
    const groups = normalizePayoutConfirmGroups(input)
    const batchId = payoutConfirmBatchId(input)
    const validation = await validatePayoutBatchConfirmation(container.resolve('em') as EntityManager, groups, batchId, scope)
    if (validation.payouts) {
      await guarded.runAfterSuccess()
      const completed = {
        payoutIds: validation.payouts.map((payout) => payout.id),
        paymentReferences: validation.payouts.map((payout) => payout.paymentReference),
      }
      return NextResponse.json(validation.payouts.length === 1
        ? { ...completed, payoutId: validation.payouts[0].id, paymentReference: validation.payouts[0].paymentReference }
        : completed)
    }
    const { translate } = await resolveTranslations()
    const failureMessage = translate('finooAffiliates.payouts.progressFailure', 'Affiliate payout creation failed')
    const progressService = container.resolve('progressService') as ProgressService
    const progressJob = await progressService.createJob({
      jobType: 'finoo_affiliates.payout.create',
      name: translate('finooAffiliates.payouts.progressName', 'Create affiliate payout'),
      description: translate('finooAffiliates.payouts.progressDescription', 'Recording confirmed affiliate payout'),
      totalCount: groups.reduce((total, group) => total + group.transactions.length, 0),
      cancellable: false,
      meta: { batchId, paymentReferences: groups.map((group) => group.paymentReference) },
    }, { ...scope, userId: auth.sub })
    try {
      const payloadBase = {
        progressJobId: progressJob.id,
        ...scope,
        userId: auth.sub,
        failureMessage,
      }
      await getFinooPayoutQueue().enqueue(batchId
        ? { ...payloadBase, batchId, groups }
        : { ...payloadBase, ...groups[0] })
    } catch (error) {
      await progressService.failJob(progressJob.id, { errorMessage: failureMessage }, { ...scope, userId: auth.sub })
      throw error
    }
    await guarded.runAfterSuccess()
    const queued = {
      progressJobId: progressJob.id,
      batchId,
      paymentReferences: groups.map((group) => group.paymentReference),
    }
    return NextResponse.json(groups.length === 1
      ? { ...queued, paymentReference: groups[0].paymentReference }
      : queued, { status: 202 })
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
        { status: 202, description: 'Payout batch queued', schema: z.object({ progressJobId: z.string().uuid(), batchId: z.string().uuid().nullable(), paymentReferences: z.array(z.string()), paymentReference: z.string().optional() }) },
        { status: 200, description: 'Payout batch already completed', schema: z.object({ payoutIds: z.array(z.string().uuid()), paymentReferences: z.array(z.string()), payoutId: z.string().uuid().optional(), paymentReference: z.string().optional() }) },
      ],
    },
  },
}
