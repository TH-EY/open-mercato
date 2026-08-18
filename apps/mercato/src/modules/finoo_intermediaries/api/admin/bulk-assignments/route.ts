import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { ProgressService } from '@open-mercato/core/modules/progress/lib/progressService'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { runRouteMutationGuards } from '@open-mercato/shared/lib/crud/route-mutation-guard'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { bulkAssignmentRequestSchema } from '../../../data/validators'
import { getFinooIntermediaryBulkAssignmentQueue } from '../../../lib/bulkAssignmentQueue'
import { canonicalBulkAssignmentDealIds, loadBulkAssignmentPreflight } from '../../../lib/bulkAssignments'
import {
  createStaffRequestContext,
  routeErrorResponse,
  unauthorizedResponse,
} from '../../../lib/http'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['finoo_intermediaries.manage'] },
  POST: { requireAuth: true, requireFeatures: ['finoo_intermediaries.manage'] },
}

const dealIdsQuerySchema = z.string().min(1).transform((value, ctx) => {
  const ids = canonicalBulkAssignmentDealIds(value.split(',').map((part) => part.trim()).filter(Boolean))
  if (ids.length < 1 || ids.length > 100 || ids.some((id) => !z.string().uuid().safeParse(id).success)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Expected 1 to 100 unique Deal ids' })
    return z.NEVER
  }
  return ids
})

function assertFreshSelection(
  input: z.infer<typeof bulkAssignmentRequestSchema>,
  preflight: Awaited<ReturnType<typeof loadBulkAssignmentPreflight>>,
): { reassignCount: number; unchangedCount: number } {
  const blocked = preflight.deals.filter((deal) => deal.state === 'blocked' || deal.blockedReason !== null)
  if (blocked.length > 0) {
    throw new CrudHttpError(422, {
      error: 'Some Deals cannot be assigned',
      code: 'bulk_assignment_blocked',
      deals: blocked.map((deal) => ({ id: deal.id, reason: deal.blockedReason })),
    })
  }
  if (!preflight.intermediaries.some((intermediary) => intermediary.id === input.intermediaryCustomerUserId)) {
    throw new CrudHttpError(404, { error: 'Resource not found' })
  }
  const currentById = new Map(preflight.deals.map((deal) => [deal.id, deal]))
  let reassignCount = 0
  let unchangedCount = 0
  for (const expected of input.deals) {
    const current = currentById.get(expected.id)
    if (!current || current.state !== 'available' || current.updatedAt !== expected.updatedAt) {
      throw new CrudHttpError(409, { error: 'A Deal changed after preview', code: 'optimistic_lock_conflict' })
    }
    const currentAssignment = current.assignment
    if (
      (currentAssignment?.id ?? null) !== expected.assignmentId
      || (currentAssignment?.updatedAt ?? null) !== expected.assignmentUpdatedAt
    ) {
      throw new CrudHttpError(409, { error: 'An assignment changed after preview', code: 'optimistic_lock_conflict' })
    }
    if (currentAssignment?.intermediaryCustomerUserId === input.intermediaryCustomerUserId) unchangedCount += 1
    else if (currentAssignment) reassignCount += 1
  }
  if (reassignCount > 0 && !input.confirmReassign) {
    throw new CrudHttpError(409, {
      error: 'Explicit confirmation is required to reassign Deals',
      code: 'reassignment_confirmation_required',
      reassignCount,
    })
  }
  return { reassignCount, unchangedCount }
}

export async function GET(request: Request) {
  try {
    const requestContext = await createStaffRequestContext(request)
    if (!requestContext) return unauthorizedResponse()
    const dealIds = dealIdsQuerySchema.parse(new URL(request.url).searchParams.get('dealIds') ?? '')
    const result = await loadBulkAssignmentPreflight(requestContext.em, {
      tenantId: requestContext.tenantId,
      organizationId: requestContext.organizationId,
      dealIds,
    })
    return NextResponse.json(result)
  } catch (error) {
    return routeErrorResponse(error)
  }
}

export async function POST(request: Request) {
  try {
    const requestContext = await createStaffRequestContext(request)
    if (!requestContext) return unauthorizedResponse()
    const parsed = bulkAssignmentRequestSchema.parse(await readJsonSafe(request, null))
    const guarded = await runRouteMutationGuards({
      container: requestContext.container,
      req: request,
      auth: {
        tenantId: requestContext.tenantId,
        organizationId: requestContext.organizationId,
        userId: requestContext.actorId,
      },
      input: {
        resourceKind: 'finoo_intermediaries.assignment_batch',
        resourceId: canonicalBulkAssignmentDealIds(parsed.deals.map((deal) => deal.id)).join(','),
        operation: 'create',
        mutationPayload: parsed,
      },
    })
    if (!guarded.ok) return guarded.response
    const input = bulkAssignmentRequestSchema.parse(guarded.modifiedPayload ?? parsed)
    const preflight = await loadBulkAssignmentPreflight(requestContext.em, {
      tenantId: requestContext.tenantId,
      organizationId: requestContext.organizationId,
      dealIds: input.deals.map((deal) => deal.id),
    })
    const counts = assertFreshSelection(input, preflight)
    if (counts.unchangedCount === input.deals.length) {
      await guarded.runAfterSuccess()
      return NextResponse.json({
        assignmentIds: preflight.deals.flatMap((deal) => deal.state === 'available' && deal.assignment ? [deal.assignment.id] : []),
        createdCount: 0,
        reassignedCount: 0,
        unchangedCount: counts.unchangedCount,
        affectedCount: 0,
      })
    }

    const { translate } = await resolveTranslations()
    const workerFailureMessage = translate(
      'finoo_intermediaries.bulk.errors.worker',
      'Bulk intermediary assignment failed. Review the selected Deals and try again.',
    )
    const progressService = requestContext.container.resolve('progressService') as ProgressService
    const progressContext = {
      tenantId: requestContext.tenantId,
      organizationId: requestContext.organizationId,
      userId: requestContext.actorId,
    }
    const progressJob = await progressService.createJob({
      jobType: 'finoo_intermediaries.assignment.bulk_upsert',
      name: translate('finoo_intermediaries.bulk.progressName', 'Assign selected Deals'),
      description: translate('finoo_intermediaries.bulk.progressDescription', 'Assigning selected Deals to an intermediary'),
      totalCount: input.deals.length,
      cancellable: false,
      meta: { dealCount: input.deals.length },
    }, progressContext)
    try {
      await getFinooIntermediaryBulkAssignmentQueue().enqueue({
        progressJobId: progressJob.id,
        tenantId: requestContext.tenantId,
        organizationId: requestContext.organizationId,
        userId: requestContext.actorId,
        failureMessage: workerFailureMessage,
        intermediaryCustomerUserId: input.intermediaryCustomerUserId,
        confirmReassign: input.confirmReassign,
        deals: input.deals,
      })
    } catch (error) {
      await progressService.failJob(progressJob.id, {
        errorMessage: translate(
          'finoo_intermediaries.bulk.errors.queue',
          'Bulk intermediary assignment could not be queued. Try again.',
        ),
      }, progressContext)
      throw error
    }
    await guarded.runAfterSuccess()
    return NextResponse.json({
      progressJobId: progressJob.id,
      createCount: input.deals.length - counts.reassignCount - counts.unchangedCount,
      reassignCount: counts.reassignCount,
      unchangedCount: counts.unchangedCount,
    }, { status: 202 })
  } catch (error) {
    return routeErrorResponse(error)
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'FINOO Intermediaries',
  summary: 'Preflight and enqueue a bulk intermediary assignment',
  methods: {
    GET: {
      summary: 'Preflight selected Deals for bulk assignment',
      query: z.object({ dealIds: z.string() }),
      responses: [{ status: 200, description: 'Bulk assignment preflight', schema: z.object({ deals: z.array(z.unknown()), intermediaries: z.array(z.unknown()) }) }],
    },
    POST: {
      summary: 'Enqueue an atomic bulk intermediary assignment',
      requestBody: { contentType: 'application/json', schema: bulkAssignmentRequestSchema },
      responses: [
        { status: 202, description: 'Bulk assignment queued', schema: z.object({ progressJobId: z.string().uuid(), createCount: z.number(), reassignCount: z.number(), unchangedCount: z.number() }) },
        { status: 200, description: 'All selected Deals were already assigned to the target', schema: z.object({ assignmentIds: z.array(z.string().uuid()), createdCount: z.number(), reassignedCount: z.number(), unchangedCount: z.number(), affectedCount: z.literal(0) }) },
      ],
    },
  },
}
