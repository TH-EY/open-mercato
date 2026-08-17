import type { EntityManager } from '@mikro-orm/postgresql'
import { createModuleQueue, type JobContext, type Queue, type QueuedJob, type WorkerMeta } from '@open-mercato/queue'
import type { CommandBus } from '@open-mercato/shared/lib/commands'
import { createLogger } from '@open-mercato/shared/lib/logger'
import {
  FINOO_INTERMEDIARY_ACCEPTANCE_RECONCILIATION_BATCH_SIZE,
  FINOO_INTERMEDIARY_ACCEPTANCE_RECONCILIATION_QUEUE,
  reconcileAcceptedIntermediaryInvitations,
} from '../lib/directoryAcceptanceReconciliation'

type ReconciliationPayload = {
  tenantId?: string
  organizationId?: string
  afterAcceptedAt?: string
  afterInvitationId?: string
}

type HandlerContext = JobContext & { resolve: <T = unknown>(name: string) => T }

const logger = createLogger('finoo_intermediaries').child({ component: 'acceptance-reconciliation' })
let continuationQueue: Queue<ReconciliationPayload> | null = null

function getContinuationQueue(): Queue<ReconciliationPayload> {
  continuationQueue ??= createModuleQueue<ReconciliationPayload>(
    FINOO_INTERMEDIARY_ACCEPTANCE_RECONCILIATION_QUEUE,
    { concurrency: 1 },
  )
  return continuationQueue
}

export const metadata: WorkerMeta = {
  queue: FINOO_INTERMEDIARY_ACCEPTANCE_RECONCILIATION_QUEUE,
  id: 'finoo_intermediaries:acceptance-reconciliation',
  concurrency: 1,
}

export default async function handle(
  job: QueuedJob<ReconciliationPayload>,
  context: HandlerContext,
): Promise<void> {
  const tenantId = job.payload?.tenantId
  const organizationId = job.payload?.organizationId
  if (!tenantId || !organizationId) {
    logger.warn('Skipping intermediary acceptance reconciliation without organization scope')
    return
  }

  const commandBus = context.resolve<CommandBus>('commandBus')
  const result = await reconcileAcceptedIntermediaryInvitations(
    context.resolve<EntityManager>('em').fork(),
    { tenantId, organizationId },
    async ({ invitationId, userId }) => {
      const executed = await commandBus.execute(
        'finoo_intermediaries.intermediary.activate_from_invitation',
        {
          input: { invitationId, userId, tenantId },
          ctx: {
            container: { resolve: context.resolve } as never,
            auth: null,
            organizationScope: null,
            selectedOrganizationId: organizationId,
            organizationIds: [organizationId],
            systemActor: true,
          },
          metadata: {
            tenantId,
            actorUserId: null,
            resourceKind: 'finoo_intermediaries.intermediary',
            resourceId: invitationId,
          },
        },
      )
      return Boolean((executed as { result?: unknown } | null)?.result)
    },
    {
      after: job.payload?.afterAcceptedAt && job.payload.afterInvitationId
        ? {
            acceptedAt: job.payload.afterAcceptedAt,
            invitationId: job.payload.afterInvitationId,
          }
        : null,
      onFailure: (invitationId, error) => {
        logger.error('Intermediary invitation acceptance reconciliation failed', {
          invitationId,
          tenantId,
          organizationId,
          err: error,
        })
      },
    },
  )

  if (
    result.selected >= FINOO_INTERMEDIARY_ACCEPTANCE_RECONCILIATION_BATCH_SIZE
    && result.continuation
  ) {
    await getContinuationQueue().enqueue({
      tenantId,
      organizationId,
      afterAcceptedAt: result.continuation.acceptedAt,
      afterInvitationId: result.continuation.invitationId,
    }, { delayMs: 1_000 })
  }
}
