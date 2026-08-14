import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandBus } from '@open-mercato/shared/lib/commands'
import { createModuleQueue, type JobContext, type Queue, type QueuedJob, type WorkerMeta } from '@open-mercato/queue'
import { createLogger } from '@open-mercato/shared/lib/logger'
import {
  FINOO_ACCEPTANCE_RECONCILIATION_BATCH_SIZE,
  FINOO_ACCEPTANCE_RECONCILIATION_QUEUE,
  reconcileAcceptedDeals,
} from '../lib/acceptanceReconciliation'

type ReconciliationPayload = {
  tenantId?: string
  organizationId?: string
  afterAcceptedAt?: string
  afterAcceptanceId?: string
}
type HandlerContext = JobContext & { resolve: <T = unknown>(name: string) => T }

const logger = createLogger('finoo_affiliates')
let continuationQueue: Queue<ReconciliationPayload> | null = null

function getContinuationQueue(): Queue<ReconciliationPayload> {
  continuationQueue ??= createModuleQueue<ReconciliationPayload>(
    FINOO_ACCEPTANCE_RECONCILIATION_QUEUE,
    { concurrency: 1 },
  )
  return continuationQueue
}

export const metadata: WorkerMeta = {
  queue: FINOO_ACCEPTANCE_RECONCILIATION_QUEUE,
  id: 'finoo_affiliates:acceptance-reconciliation',
  concurrency: 1,
}

export default async function handle(job: QueuedJob<ReconciliationPayload>, context: HandlerContext): Promise<void> {
  const tenantId = job.payload?.tenantId
  const organizationId = job.payload?.organizationId
  if (!tenantId || !organizationId) {
    logger.warn('Skipping affiliate acceptance reconciliation without tenant scope')
    return
  }
  const scope = { tenantId, organizationId }
  const commandBus = context.resolve<CommandBus>('commandBus')
  const result = await reconcileAcceptedDeals(
    context.resolve<EntityManager>('em').fork(),
    scope,
    async (dealId) => {
      const executed = await commandBus.execute('finoo_affiliates.transaction.create', {
        input: { dealId },
        ctx: {
          container: { resolve: context.resolve } as never,
          auth: { tenantId } as never,
          organizationScope: null,
          selectedOrganizationId: organizationId,
          organizationIds: [organizationId],
          systemActor: true,
        },
      })
      return Boolean((executed as { result?: unknown } | null)?.result)
    },
    {
      after: job.payload?.afterAcceptedAt && job.payload?.afterAcceptanceId
        ? {
            acceptedAt: job.payload.afterAcceptedAt,
            acceptanceId: job.payload.afterAcceptanceId,
          }
        : null,
      onFailure: (dealId, error) => {
        logger.error('Affiliate acceptance reconciliation failed for Deal', {
          dealId,
          err: error,
        })
      },
    },
  )
  if (result.selected >= FINOO_ACCEPTANCE_RECONCILIATION_BATCH_SIZE && result.continuation) {
    await getContinuationQueue().enqueue({
      ...scope,
      afterAcceptedAt: result.continuation.acceptedAt,
      afterAcceptanceId: result.continuation.acceptanceId,
    }, { delayMs: 1_000 })
  }
}
