import type { EntityManager } from '@mikro-orm/postgresql'
import type { JobContext, QueuedJob, WorkerMeta } from '@open-mercato/queue'
import type { CommandBus } from '@open-mercato/shared/lib/commands'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { FinooApplicationIntake, FinooApplicationProjection } from '../data/entities'
import { FINOO_APPLICATION_MAX_ATTEMPTS, FINOO_APPLICATION_QUEUE, type FinooApplicationJob } from '../lib/queue'
import { projectFinooApplication, safeProjectionErrorCode } from '../lib/projector'

export const metadata: WorkerMeta = { queue: FINOO_APPLICATION_QUEUE, id: 'finoo_applications:project', concurrency: 2 }

export default async function handle(job: QueuedJob<FinooApplicationJob>, _context: JobContext): Promise<void> {
  const container = await createRequestContainer()
  const scope = { tenantId: job.payload.tenantId, organizationId: job.payload.organizationId }
  const em = (container.resolve('em') as EntityManager).fork()
  const now = new Date()
  const processingLeaseExpiresAt = new Date(now.getTime() + 5 * 60_000)
  const claimedRows = await em.getConnection().execute<Array<{ attempt_count: number }>>(
    `update finoo_application_intakes
       set state = 'processing',
           dispatch_state = 'enqueued',
           dispatch_lease_expires_at = ?,
           attempt_count = attempt_count + 1,
           lease_expires_at = ?,
           updated_at = ?
     where id = ?
       and tenant_id = ?
       and organization_id = ?
       and (
         state = 'pending'
         or (state = 'retrying' and (next_attempt_at is null or next_attempt_at <= ?))
         or (state = 'processing' and lease_expires_at <= ?)
       )
     returning attempt_count`,
    [processingLeaseExpiresAt, processingLeaseExpiresAt, now, job.payload.intakeId, scope.tenantId, scope.organizationId, now, now],
  )
  const persistentAttempt = Number(claimedRows[0]?.attempt_count ?? 0)
  if (!persistentAttempt) return
  const intake = await findOneWithDecryption(em, FinooApplicationIntake, { ...scope, id: job.payload.intakeId }, undefined, scope)
  if (!intake) return
  try {
    await projectFinooApplication(em, container.resolve('commandBus') as CommandBus, container, intake)
    intake.state = 'processed'
    intake.processedAt = new Date()
    intake.lastErrorCode = null
    intake.nextAttemptAt = null
    intake.leaseExpiresAt = null
    await em.flush()
  } catch (error) {
    const errorCode = safeProjectionErrorCode(error)
    intake.attemptCount = persistentAttempt
    intake.lastErrorCode = errorCode
    intake.leaseExpiresAt = null
    if (persistentAttempt >= FINOO_APPLICATION_MAX_ATTEMPTS) {
      intake.state = 'failed'
      intake.nextAttemptAt = null
    } else {
      intake.state = 'retrying'
      intake.dispatchState = 'pending'
      intake.nextAttemptAt = new Date(Date.now() + Math.min(60_000, 1_000 * 2 ** persistentAttempt))
    }
    await em.nativeUpdate(FinooApplicationProjection, {
      ...scope,
      externalLeadId: intake.externalLeadId,
    }, { lastErrorCode: errorCode })
    await em.flush()
    throw error
  }
}
