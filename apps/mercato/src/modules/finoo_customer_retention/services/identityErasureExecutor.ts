import type { EntityManager } from '@mikro-orm/postgresql'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import {
  FinooCustomerRetentionSettings,
  FinooCustomerRetentionState,
} from '../data/entities'
import type { FinooCustomerRetentionProjectionService } from './projectionService'

export const FINOO_IDENTITY_ERASURE_DEFAULT_BATCH_SIZE = 100
export const FINOO_IDENTITY_ERASURE_MAX_BATCH_SIZE = 500

export type FinooIdentityErasureScope = {
  tenantId: string
  organizationId: string
}

export type FinooIdentityErasurePort = {
  anonymizeAndDeleteForPerson: (request: FinooIdentityErasureScope & {
    personId: string
    systemActor: true
  }) => Promise<unknown>
}

type ExecuteInput = FinooIdentityErasureScope & {
  apply: boolean
  batchSize?: number
  now?: Date
}

export type FinooIdentityErasureExecutionResult = {
  eligibleCount: number
  selectedCount: number
  processedCount: number
}

function dueRetentionPredicate(scope: FinooIdentityErasureScope, now: Date) {
  return {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    retentionStatus: 'expired' as const,
    retentionExpiresAt: { $lte: now },
    identityErasedAt: null,
    deletedAt: null,
  }
}

function resolveIdentityRetention(container: AppContainer): FinooIdentityErasurePort {
  if (!container.hasRegistration('finooIdentityRetention')) {
    throw new Error('[internal] Finoo identity retention port is unavailable')
  }
  const port = container.resolve('finooIdentityRetention') as Partial<FinooIdentityErasurePort>
  if (typeof port.anonymizeAndDeleteForPerson !== 'function') {
    throw new Error('[internal] Finoo identity retention port is unavailable')
  }
  return port as FinooIdentityErasurePort
}

function resolveProjectionService(container: AppContainer): FinooCustomerRetentionProjectionService {
  if (!container.hasRegistration('finooCustomerRetentionProjectionService')) {
    throw new Error('[internal] Finoo retention projection service is unavailable')
  }
  const service = container.resolve('finooCustomerRetentionProjectionService') as Partial<
    FinooCustomerRetentionProjectionService
  >
  if (typeof service.runIdentityErasureIfAuthoritativelyDue !== 'function') {
    throw new Error('[internal] Finoo retention projection service is unavailable')
  }
  return service as FinooCustomerRetentionProjectionService
}

export function createFinooIdentityErasureExecutor(dependencies: {
  em: EntityManager
  container: AppContainer
}) {
  return {
    async execute(input: ExecuteInput): Promise<FinooIdentityErasureExecutionResult> {
      const now = input.now ?? new Date()
      const batchSize = input.batchSize ?? FINOO_IDENTITY_ERASURE_DEFAULT_BATCH_SIZE
      if (
        !Number.isSafeInteger(batchSize)
        || batchSize < 1
        || batchSize > FINOO_IDENTITY_ERASURE_MAX_BATCH_SIZE
      ) {
        throw new Error('[internal] Identity erasure batch size is outside the allowed range')
      }
      const predicate = dueRetentionPredicate(input, now)
      const eligibleCount = await dependencies.em.count(FinooCustomerRetentionState, predicate)

      if (!input.apply) {
        return {
          eligibleCount,
          selectedCount: Math.min(eligibleCount, batchSize),
          processedCount: 0,
        }
      }

      const identityRetention = resolveIdentityRetention(dependencies.container)
      const projectionService = resolveProjectionService(dependencies.container)
      const settings = await dependencies.em.findOne(FinooCustomerRetentionSettings, {
        tenantId: input.tenantId,
        organizationId: input.organizationId,
      }, { fields: ['reconciliationGeneration'] })
      if (!settings) throw new Error('[internal] Finoo retention settings are missing')
      const candidates = await dependencies.em.find(FinooCustomerRetentionState, predicate, {
        fields: ['id', 'customerEntityId'],
        orderBy: { customerEntityId: 'ASC', id: 'ASC' },
        limit: batchSize,
      })

      let processedCount = 0
      for (const candidate of candidates) {
        const authoritative = await projectionService.runIdentityErasureIfAuthoritativelyDue({
          tenantId: input.tenantId,
          organizationId: input.organizationId,
          customerEntityId: candidate.customerEntityId,
          reconciliationGeneration: settings.reconciliationGeneration,
        }, async () => {
          await identityRetention.anonymizeAndDeleteForPerson({
            tenantId: input.tenantId,
            organizationId: input.organizationId,
            personId: candidate.customerEntityId,
            systemActor: true,
          })
        })
        if (authoritative.operationApplied) processedCount += 1
      }

      return {
        eligibleCount,
        selectedCount: candidates.length,
        processedCount,
      }
    },
  }
}

export type FinooIdentityErasureExecutor = ReturnType<typeof createFinooIdentityErasureExecutor>
