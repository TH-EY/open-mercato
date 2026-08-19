import type { EntityManager } from '@mikro-orm/postgresql'
import type { QueuedJob, WorkerMeta } from '@open-mercato/queue'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { FinooApplicationIntake } from '../data/entities'
import { dispatchFinooApplicationIntake } from '../lib/dispatch'

export const FINOO_APPLICATION_RECONCILE_QUEUE = 'finoo-applications-reconcile'
type ReconcileJob = { tenantId: string; organizationId: string }
type HandlerContext = { resolve: <T = unknown>(name: string) => T }

export const metadata: WorkerMeta = { queue: FINOO_APPLICATION_RECONCILE_QUEUE, id: 'finoo_applications:reconcile', concurrency: 1 }

export default async function handle(_job: QueuedJob<ReconcileJob>, context: HandlerContext): Promise<void> {
  const scope = _job.payload
  const em = context.resolve<EntityManager>('em').fork()
  const now = new Date()
  const rows = await findWithDecryption(em, FinooApplicationIntake, {
    ...scope,
    $or: [
      { state: 'pending' },
      { state: 'retrying', nextAttemptAt: { $lte: now } },
      { state: 'processing', leaseExpiresAt: { $lte: now } },
    ],
  }, { orderBy: { createdAt: 'asc' }, limit: 100 }, scope)
  for (const intake of rows) {
    await dispatchFinooApplicationIntake(em, { intakeId: intake.id, ...scope })
  }
}
