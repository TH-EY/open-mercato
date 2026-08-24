import type { JobContext, QueuedJob, WorkerMeta } from '@open-mercato/queue'
import type { EntityManager } from '@mikro-orm/postgresql'
import { LockMode } from '@mikro-orm/core'
import { ProgressJob } from '@open-mercato/core/modules/progress/data/entities'
import type {
  ProgressService,
  ProgressServiceContext,
} from '@open-mercato/core/modules/progress/lib/progressService'
import { calculateProgressPercent } from '@open-mercato/core/modules/progress/lib/progressService'
import { createLogger } from '@open-mercato/shared/lib/logger'
import {
  FINOO_CUSTOMER_RETENTION_MAX_ATTEMPTS,
  FINOO_CUSTOMER_RETENTION_RECONCILE_QUEUE,
} from '../lib/constants'
import {
  getFinooCustomerRetentionReconciliationQueue,
  type FinooCustomerRetentionReconciliationPayload,
} from '../lib/reconciliationQueue'
import type { FinooCustomerRetentionProjectionService } from '../services/projectionService'

type HandlerContext = JobContext & { resolve: <T = unknown>(name: string) => T }

const logger = createLogger('finoo_customer_retention').child({ component: 'reconcile-worker' })
const PROGRESS_RECOVERY_AGE_MS = 5 * 60 * 1000

export const metadata: WorkerMeta = {
  queue: FINOO_CUSTOMER_RETENTION_RECONCILE_QUEUE,
  id: 'finoo_customer_retention:reconcile',
  concurrency: 1,
}

function progressContext(
  payload: FinooCustomerRetentionReconciliationPayload,
): ProgressServiceContext {
  return {
    tenantId: payload.tenantId,
    organizationId: payload.organizationId,
    userId: payload.actorUserId ?? null,
  }
}

function reconciliationGeneration(job: ProgressJob): number | undefined {
  const generation = job.meta?.reconciliationGeneration
  return typeof generation === 'number' && Number.isSafeInteger(generation)
    ? generation
    : undefined
}

function checkpointCursor(job: ProgressJob): string | null {
  const cursor = job.meta?.nextAfterCustomerEntityId
  return typeof cursor === 'string' ? cursor : null
}

function checkpointComplete(job: ProgressJob): boolean {
  return job.meta?.checkpointComplete === true
}

function lastEnqueuedCursor(job: ProgressJob): string | null {
  const cursor = job.meta?.lastEnqueuedCustomerEntityId
  return typeof cursor === 'string' ? cursor : null
}

async function loadProgressJob(
  payload: FinooCustomerRetentionReconciliationPayload,
  context: HandlerContext,
): Promise<ProgressJob | null> {
  if (!payload.progressJobId) return null
  return context.resolve<EntityManager>('em').fork().findOne(ProgressJob, {
    id: payload.progressJobId,
    tenantId: payload.tenantId,
    organizationId: payload.organizationId,
    jobType: 'finoo_customer_retention.reconcile',
  })
}

async function commitProgressCheckpoint(
  payload: FinooCustomerRetentionReconciliationPayload,
  context: HandlerContext,
  result: {
    processed: number
    changed: number
    nextCustomerEntityId: string | null
    staleGeneration: boolean
    reconciliationGeneration: number
  },
): Promise<{ accepted: boolean; job: ProgressJob | null }> {
  if (!payload.progressJobId) return { accepted: true, job: null }
  return context.resolve<EntityManager>('em').fork().transactional(async (em) => {
    const progressJob = await em.findOne(ProgressJob, {
      id: payload.progressJobId,
      tenantId: payload.tenantId,
      organizationId: payload.organizationId,
      jobType: 'finoo_customer_retention.reconcile',
    }, { lockMode: LockMode.PESSIMISTIC_WRITE })
    if (!progressJob || checkpointComplete(progressJob)) {
      return { accepted: false, job: progressJob }
    }
    const payloadCursor = payload.afterCustomerEntityId ?? null
    if (checkpointCursor(progressJob) !== payloadCursor) {
      return { accepted: false, job: progressJob }
    }
    const currentGeneration = reconciliationGeneration(progressJob)
    if (
      currentGeneration !== undefined
      && currentGeneration !== result.reconciliationGeneration
    ) {
      return { accepted: false, job: progressJob }
    }

    progressJob.processedCount += result.processed
    progressJob.progressPercent = calculateProgressPercent(
      progressJob.processedCount,
      progressJob.totalCount ?? null,
    )
    progressJob.heartbeatAt = new Date()
    progressJob.meta = {
      ...progressJob.meta,
      reconciliationGeneration: result.reconciliationGeneration,
      nextAfterCustomerEntityId: result.nextCustomerEntityId,
      checkpointComplete: result.staleGeneration || !result.nextCustomerEntityId,
    }
    await em.flush()
    return { accepted: true, job: progressJob }
  })
}

async function markContinuationEnqueued(
  payload: FinooCustomerRetentionReconciliationPayload,
  context: HandlerContext,
  cursor: string,
): Promise<void> {
  if (!payload.progressJobId) return
  await context.resolve<EntityManager>('em').fork().transactional(async (em) => {
    const progressJob = await em.findOne(ProgressJob, {
      id: payload.progressJobId,
      tenantId: payload.tenantId,
      organizationId: payload.organizationId,
      jobType: 'finoo_customer_retention.reconcile',
    }, { lockMode: LockMode.PESSIMISTIC_WRITE })
    if (!progressJob || checkpointCursor(progressJob) !== cursor) return
    progressJob.meta = {
      ...progressJob.meta,
      lastEnqueuedCustomerEntityId: cursor,
    }
    await em.flush()
  })
}

async function enqueueProgressContinuation(
  payload: FinooCustomerRetentionReconciliationPayload,
  context: HandlerContext,
  cursor: string,
  generation: number,
): Promise<void> {
  await getFinooCustomerRetentionReconciliationQueue().enqueue({
    tenantId: payload.tenantId,
    organizationId: payload.organizationId,
    progressJobId: payload.progressJobId,
    actorUserId: payload.actorUserId,
    afterCustomerEntityId: cursor,
    reconciliationGeneration: generation,
  })
  await markContinuationEnqueued(payload, context, cursor)
}

async function recoverPendingProgressJobs(
  payload: FinooCustomerRetentionReconciliationPayload,
  context: HandlerContext,
): Promise<void> {
  if (
    payload.progressJobId
    || payload.customerEntityId
    || payload.afterCustomerEntityId
    || payload.reconciliationGeneration !== undefined
  ) return

  const em = context.resolve<EntityManager>('em').fork()
  const pendingJobs = await em.find(ProgressJob, {
    tenantId: payload.tenantId,
    organizationId: payload.organizationId,
    jobType: 'finoo_customer_retention.reconcile',
    status: { $in: ['pending', 'running'] },
    updatedAt: { $lte: new Date(Date.now() - PROGRESS_RECOVERY_AGE_MS) },
  }, {
    orderBy: { createdAt: 'ASC' },
    limit: 100,
  })
  const queue = getFinooCustomerRetentionReconciliationQueue()
  for (const pendingJob of pendingJobs) {
    const generation = reconciliationGeneration(pendingJob)
    if (generation === undefined) continue
    const cursor = checkpointCursor(pendingJob)
    await queue.enqueue({
      tenantId: payload.tenantId,
      organizationId: payload.organizationId,
      reconciliationGeneration: generation,
      progressJobId: pendingJob.id,
      actorUserId: pendingJob.startedByUserId ?? null,
      ...(cursor
        ? { afterCustomerEntityId: cursor }
        : {}),
    })
    if (cursor) {
      await markContinuationEnqueued({
        tenantId: payload.tenantId,
        organizationId: payload.organizationId,
        progressJobId: pendingJob.id,
      }, context, cursor)
    }
  }
}

export default async function handle(
  job: QueuedJob<FinooCustomerRetentionReconciliationPayload>,
  context: HandlerContext,
): Promise<void> {
  const payload = job.payload
  if (!payload?.tenantId || !payload.organizationId) {
    logger.warn('Skipping retention reconciliation without organization scope')
    return
  }
  const progressService = payload.progressJobId
    ? context.resolve<ProgressService>('progressService')
    : null
  const progress = payload.progressJobId ? progressContext(payload) : null
  try {
    await recoverPendingProgressJobs(payload, context)
    const projectionService = context.resolve<FinooCustomerRetentionProjectionService>(
      'finooCustomerRetentionProjectionService',
    )
    if (payload.customerEntityId) {
      await projectionService.reconcilePerson({
        tenantId: payload.tenantId,
        organizationId: payload.organizationId,
        customerEntityId: payload.customerEntityId,
        reconciliationGeneration: payload.reconciliationGeneration,
      })
      return
    }

    if (payload.progressJobId && progressService && progress) {
      const progressJob = await loadProgressJob(payload, context)
      if (!progressJob) return
      if (checkpointComplete(progressJob)) {
        await progressService.completeJob(payload.progressJobId, {
          resultSummary: { recoveredFromCheckpoint: true },
        }, progress)
        return
      }
      const expectedCursor = checkpointCursor(progressJob)
      if (expectedCursor !== (payload.afterCustomerEntityId ?? null)) {
        const generation = reconciliationGeneration(progressJob)
        if (
          expectedCursor
          && generation !== undefined
          && lastEnqueuedCursor(progressJob) !== expectedCursor
        ) {
          await enqueueProgressContinuation(payload, context, expectedCursor, generation)
        }
        return
      }
      await progressService.startJob(payload.progressJobId, progress)
    }

    const result = await projectionService.reconcilePage({
      tenantId: payload.tenantId,
      organizationId: payload.organizationId,
      afterCustomerEntityId: payload.afterCustomerEntityId,
      reconciliationGeneration: payload.reconciliationGeneration,
    })
    if (payload.progressJobId && progressService && progress) {
      const checkpoint = await commitProgressCheckpoint(payload, context, result)
      if (!checkpoint.accepted || !checkpoint.job) return
      await progressService.updateProgress(payload.progressJobId, {
        processedCount: checkpoint.job.processedCount,
        progressPercent: checkpoint.job.progressPercent,
        meta: checkpoint.job.meta ?? undefined,
      }, progress)
      if (checkpointComplete(checkpoint.job)) {
        await progressService.completeJob(payload.progressJobId, {
          resultSummary: {
            staleGeneration: result.staleGeneration,
            processed: result.processed,
            changed: result.changed,
          },
        }, progress)
        return
      }
    }
    if (result.staleGeneration || !result.nextCustomerEntityId) return

    if (payload.progressJobId) {
      await enqueueProgressContinuation(
        payload,
        context,
        result.nextCustomerEntityId,
        result.reconciliationGeneration,
      )
    } else {
      await getFinooCustomerRetentionReconciliationQueue().enqueue({
        tenantId: payload.tenantId,
        organizationId: payload.organizationId,
        actorUserId: payload.actorUserId,
        afterCustomerEntityId: result.nextCustomerEntityId,
        reconciliationGeneration: result.reconciliationGeneration,
      })
    }
  } catch (error) {
    if (
      payload.progressJobId
      && progressService
      && progress
      && context.attemptNumber >= FINOO_CUSTOMER_RETENTION_MAX_ATTEMPTS
    ) {
      await progressService.failJob(payload.progressJobId, {
        errorMessage: 'Finoo customer retention reconciliation failed',
      }, progress)
    }
    throw error
  }
}
