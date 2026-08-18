import { createModuleQueue, resolveQueueStrategy, type Queue } from '@open-mercato/queue'
import type { BulkAssignmentDealInput } from '../data/validators'

export const FINOO_INTERMEDIARY_BULK_ASSIGNMENT_QUEUE = 'finoo-intermediaries-assignment-bulk'
export const FINOO_INTERMEDIARY_BULK_ASSIGNMENT_MAX_ATTEMPTS = resolveQueueStrategy() === 'async' ? 5 : 3

export type FinooIntermediaryBulkAssignmentJobPayload = {
  progressJobId: string
  tenantId: string
  organizationId: string
  userId: string
  failureMessage: string
  intermediaryCustomerUserId: string
  confirmReassign: boolean
  deals: BulkAssignmentDealInput[]
}

let bulkAssignmentQueue: Queue<FinooIntermediaryBulkAssignmentJobPayload> | null = null

export function getFinooIntermediaryBulkAssignmentQueue(): Queue<FinooIntermediaryBulkAssignmentJobPayload> {
  bulkAssignmentQueue ??= createModuleQueue<FinooIntermediaryBulkAssignmentJobPayload>(
    FINOO_INTERMEDIARY_BULK_ASSIGNMENT_QUEUE,
    { concurrency: 3, attempts: 5 },
  )
  return bulkAssignmentQueue
}
