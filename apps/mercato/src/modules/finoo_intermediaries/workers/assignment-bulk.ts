import type { JobContext, QueuedJob, WorkerMeta } from '@open-mercato/queue'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { CommandBus } from '@open-mercato/shared/lib/commands'
import type { ProgressService, ProgressServiceContext } from '@open-mercato/core/modules/progress/lib/progressService'
import type { FinooIntermediaryAssignmentBatchResult } from '../data/entities'
import {
  FINOO_INTERMEDIARY_BULK_ASSIGNMENT_MAX_ATTEMPTS,
  FINOO_INTERMEDIARY_BULK_ASSIGNMENT_QUEUE,
  type FinooIntermediaryBulkAssignmentJobPayload,
} from '../lib/bulkAssignmentQueue'

export const metadata: WorkerMeta = {
  queue: FINOO_INTERMEDIARY_BULK_ASSIGNMENT_QUEUE,
  id: 'finoo-intermediaries:assignment-bulk',
  concurrency: 3,
}

export default async function handle(
  job: QueuedJob<FinooIntermediaryBulkAssignmentJobPayload>,
  context: JobContext,
): Promise<void> {
  const container = await createRequestContainer()
  const payload = job.payload
  const progressService = container.resolve('progressService') as ProgressService
  const progressContext: ProgressServiceContext = {
    tenantId: payload.tenantId,
    organizationId: payload.organizationId,
    userId: payload.userId,
  }
  try {
    await progressService.startJob(payload.progressJobId, progressContext)
    const commandBus = container.resolve('commandBus') as CommandBus
    const { result } = await commandBus.execute<Record<string, unknown>, FinooIntermediaryAssignmentBatchResult>(
      'finoo_intermediaries.assignment.bulk_upsert',
      {
        input: {
          operationId: payload.progressJobId,
          tenantId: payload.tenantId,
          organizationId: payload.organizationId,
          actorUserId: payload.userId,
          intermediaryCustomerUserId: payload.intermediaryCustomerUserId,
          confirmReassign: payload.confirmReassign,
          deals: payload.deals,
        },
        ctx: {
          container,
          auth: null,
          organizationScope: null,
          selectedOrganizationId: payload.organizationId,
          organizationIds: [payload.organizationId],
          systemActor: true,
        },
      },
    )
    await progressService.updateProgress(payload.progressJobId, {
      totalCount: payload.deals.length,
      processedCount: payload.deals.length,
    }, progressContext)
    await progressService.completeJob(payload.progressJobId, { resultSummary: result }, progressContext)
  } catch (error) {
    if (context.attemptNumber >= FINOO_INTERMEDIARY_BULK_ASSIGNMENT_MAX_ATTEMPTS) {
      await progressService.failJob(payload.progressJobId, {
        errorMessage: payload.failureMessage,
      }, progressContext)
    }
    throw error
  }
}
