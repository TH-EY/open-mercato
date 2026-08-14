import type { JobContext, QueuedJob, WorkerMeta } from '@open-mercato/queue'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { CommandBus } from '@open-mercato/shared/lib/commands'
import type { ProgressService, ProgressServiceContext } from '@open-mercato/core/modules/progress/lib/progressService'
import type { FinooAffiliatePayout } from '../data/entities'
import { FINOO_PAYOUT_QUEUE, type FinooPayoutJobPayload } from '../lib/payoutQueue'

export const metadata: WorkerMeta = {
  queue: FINOO_PAYOUT_QUEUE,
  id: 'finoo-affiliates:payout-create',
  concurrency: 3,
}

export default async function handle(job: QueuedJob<FinooPayoutJobPayload>, _context: JobContext): Promise<void> {
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
    const { result } = await commandBus.execute<Record<string, unknown>, FinooAffiliatePayout>(
      'finoo_affiliates.payout.create',
      {
        input: {
          paymentReference: payload.paymentReference,
          affiliateUpdatedAt: payload.affiliateUpdatedAt,
          transactions: payload.transactions,
          tenantId: payload.tenantId,
          organizationId: payload.organizationId,
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
      totalCount: payload.transactions.length,
      processedCount: payload.transactions.length,
    }, progressContext)
    await progressService.completeJob(payload.progressJobId, {
      resultSummary: { payoutId: result.id, paymentReference: result.paymentReference },
    }, progressContext)
  } catch (error) {
    await progressService.failJob(payload.progressJobId, {
      errorMessage: error instanceof Error ? error.message : 'Affiliate payout creation failed',
      errorStack: error instanceof Error ? error.stack?.slice(0, 10_000) : undefined,
    }, progressContext)
    throw error
  }
}
