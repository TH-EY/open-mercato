import type { EntityManager } from '@mikro-orm/postgresql'
import type { JobContext, QueuedJob, WorkerMeta } from '@open-mercato/queue'
import { FINOO_PAYOUT_PREVIEW_PRUNE_QUEUE, pruneExpiredPayoutPreviews } from '../lib/payouts'

type Payload = { tenantId?: string; organizationId?: string }
type Context = JobContext & { resolve: <T = unknown>(name: string) => T }

export const metadata: WorkerMeta = { queue: FINOO_PAYOUT_PREVIEW_PRUNE_QUEUE, id: 'finoo-affiliates:payout-preview-prune', concurrency: 1 }

export default async function handle(job: QueuedJob<Payload>, context: Context): Promise<void> {
  const tenantId = job.payload.tenantId
  const organizationId = job.payload.organizationId
  if (!tenantId || !organizationId) return
  await pruneExpiredPayoutPreviews(context.resolve<EntityManager>('em').fork(), { tenantId, organizationId })
}
