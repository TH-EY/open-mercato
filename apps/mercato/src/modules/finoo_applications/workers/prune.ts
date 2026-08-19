import type { EntityManager } from '@mikro-orm/postgresql'
import type { QueuedJob, WorkerMeta } from '@open-mercato/queue'
import { FinooApplicationIntake } from '../data/entities'

export const FINOO_APPLICATION_PRUNE_QUEUE = 'finoo-applications-prune'
type PruneJob = { tenantId: string; organizationId: string }
type HandlerContext = { resolve: <T = unknown>(name: string) => T }

export const metadata: WorkerMeta = { queue: FINOO_APPLICATION_PRUNE_QUEUE, id: 'finoo_applications:prune', concurrency: 1 }

export default async function handle(job: QueuedJob<PruneJob>, context: HandlerContext): Promise<void> {
  const em = context.resolve<EntityManager>('em').fork()
  const now = Date.now()
  await em.nativeUpdate(FinooApplicationIntake, {
    ...job.payload,
    state: 'processed',
    processedAt: { $lte: new Date(now - 30 * 24 * 60 * 60_000) },
    payloadJson: { $ne: null },
  }, { payloadJson: null })
  await em.nativeUpdate(FinooApplicationIntake, {
    ...job.payload,
    state: 'failed',
    updatedAt: { $lte: new Date(now - 90 * 24 * 60 * 60_000) },
    payloadJson: { $ne: null },
  }, { payloadJson: null })
}
