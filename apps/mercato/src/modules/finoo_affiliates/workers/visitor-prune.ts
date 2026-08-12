import type { EntityManager } from '@mikro-orm/postgresql'
import { createModuleQueue, type JobContext, type Queue, type QueuedJob, type WorkerMeta } from '@open-mercato/queue'
import { createLogger } from '@open-mercato/shared/lib/logger'
import {
  anonymizeExpiredAffiliateVisitors,
  FINOO_AFFILIATE_VISITOR_PRUNE_BATCH_SIZE,
  FINOO_AFFILIATE_VISITOR_PRUNE_QUEUE,
} from '../lib/visitRetention'

type PrunePayload = { tenantId?: string; organizationId?: string }
type HandlerContext = JobContext & { resolve: <T = unknown>(name: string) => T }

const logger = createLogger('finoo_affiliates')
let continuationQueue: Queue<PrunePayload> | null = null

function getContinuationQueue(): Queue<PrunePayload> {
  continuationQueue ??= createModuleQueue<PrunePayload>(
    FINOO_AFFILIATE_VISITOR_PRUNE_QUEUE,
    { concurrency: 1 },
  )
  return continuationQueue
}

export const metadata: WorkerMeta = {
  queue: FINOO_AFFILIATE_VISITOR_PRUNE_QUEUE,
  id: 'finoo_affiliates:visitor-prune',
  concurrency: 1,
}

export default async function handle(job: QueuedJob<PrunePayload>, context: HandlerContext): Promise<void> {
  const tenantId = job.payload?.tenantId
  const organizationId = job.payload?.organizationId
  if (!tenantId || !organizationId) {
    logger.warn('Skipping affiliate visitor prune without tenant scope')
    return
  }
  const anonymized = await anonymizeExpiredAffiliateVisitors(
    context.resolve<EntityManager>('em').fork(),
    { tenantId, organizationId },
    { batchSize: FINOO_AFFILIATE_VISITOR_PRUNE_BATCH_SIZE },
  )
  if (anonymized >= FINOO_AFFILIATE_VISITOR_PRUNE_BATCH_SIZE) {
    await getContinuationQueue().enqueue({ tenantId, organizationId }, { delayMs: 1_000 })
  }
}
