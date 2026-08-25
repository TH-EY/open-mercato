import { createModuleQueue, type Queue } from '@open-mercato/queue'
import {
  FINOO_CUSTOMER_RETENTION_MAX_ATTEMPTS,
  FINOO_CUSTOMER_RETENTION_RECONCILE_QUEUE,
} from './constants'

export type FinooCustomerRetentionReconciliationPayload = {
  tenantId: string
  organizationId: string
  customerEntityId?: string
  reconciliationGeneration?: number
  afterCustomerEntityId?: string
  progressJobId?: string
  actorUserId?: string | null
}

let reconciliationQueue: Queue<FinooCustomerRetentionReconciliationPayload> | null = null

export function getFinooCustomerRetentionReconciliationQueue(): Queue<FinooCustomerRetentionReconciliationPayload> {
  reconciliationQueue ??= createModuleQueue<FinooCustomerRetentionReconciliationPayload>(
    FINOO_CUSTOMER_RETENTION_RECONCILE_QUEUE,
    { concurrency: 1, attempts: FINOO_CUSTOMER_RETENTION_MAX_ATTEMPTS },
  )
  return reconciliationQueue
}
