import { LockMode } from '@mikro-orm/core'
import type { EntityManager } from '@mikro-orm/postgresql'
import { FinooCustomerRetentionState } from '../data/entities'
import type { FinooRetentionScope } from './projectionService'
import { lockRetentionSubject } from './retentionLock'

export type FinooIdentityErasureCompletionInvalidation = FinooRetentionScope & {
  customerEntityId: string
  em: EntityManager
}

export function createFinooIdentityErasureCompletionGuard() {
  return {
    async invalidateForRawWrite(
      input: FinooIdentityErasureCompletionInvalidation,
    ): Promise<void> {
      if (!input.em.isInTransaction()) {
        throw new Error('[internal] Identity erasure completion can only be invalidated transactionally')
      }
      const scope = {
        tenantId: input.tenantId,
        organizationId: input.organizationId,
      }
      await lockRetentionSubject(input.em, scope, input.customerEntityId)
      const state = await input.em.findOne(FinooCustomerRetentionState, {
        ...scope,
        customerEntityId: input.customerEntityId,
        deletedAt: null,
      }, {
        fields: ['id', 'identityErasedAt'],
        lockMode: LockMode.PESSIMISTIC_WRITE,
      })
      if (!state?.identityErasedAt) return
      state.identityErasedAt = null
      await input.em.flush()
    },
  }
}

export type FinooIdentityErasureCompletionGuard = ReturnType<
  typeof createFinooIdentityErasureCompletionGuard
>
