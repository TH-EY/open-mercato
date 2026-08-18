import type { JobContext, QueuedJob, WorkerMeta } from '@open-mercato/queue'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { CommandBus } from '@open-mercato/shared/lib/commands'
import type { ProgressService, ProgressServiceContext } from '@open-mercato/core/modules/progress/lib/progressService'
import type { FinooAffiliatePayout } from '../data/entities'
import {
  FINOO_PAYOUT_MAX_ATTEMPTS,
  FINOO_PAYOUT_QUEUE,
  payoutJobBatchId,
  payoutJobGroups,
  type FinooPayoutJobPayload,
} from '../lib/payoutQueue'

export const metadata: WorkerMeta = {
  queue: FINOO_PAYOUT_QUEUE,
  id: 'finoo-affiliates:payout-create',
  concurrency: 3,
}

export default async function handle(job: QueuedJob<FinooPayoutJobPayload>, context: JobContext): Promise<void> {
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
    const groups = payoutJobGroups(payload)
    const batchId = payoutJobBatchId(payload)
    let result: {
      payouts: FinooAffiliatePayout[]
      paymentReferences: string[]
    }
    if (batchId) {
      const executed = await commandBus.execute<Record<string, unknown>, typeof result>(
        'finoo_affiliates.payout_batch.create',
        {
          input: {
            batchId,
            groups,
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
      result = executed.result
    } else {
      if (groups.length !== 1) throw new Error('[internal] Legacy payout job must contain exactly one group')
      const executed = await commandBus.execute<Record<string, unknown>, FinooAffiliatePayout>(
        'finoo_affiliates.payout.create',
        {
          input: {
            ...groups[0],
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
      result = {
        payouts: [executed.result],
        paymentReferences: [executed.result.paymentReference],
      }
    }
    const transactionCount = groups.reduce((total, group) => total + group.transactions.length, 0)
    await progressService.updateProgress(payload.progressJobId, {
      totalCount: transactionCount,
      processedCount: transactionCount,
    }, progressContext)
    await progressService.completeJob(payload.progressJobId, {
      resultSummary: {
        payoutIds: result.payouts.map((payout) => payout.id),
        paymentReferences: result.paymentReferences,
      },
    }, progressContext)
  } catch (error) {
    if (context.attemptNumber >= FINOO_PAYOUT_MAX_ATTEMPTS) {
      await progressService.failJob(payload.progressJobId, {
        errorMessage: payload.failureMessage ?? 'Affiliate payout creation failed',
      }, progressContext)
    }
    throw error
  }
}
