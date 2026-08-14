import { createModuleQueue, type Queue } from '@open-mercato/queue'
import type { FinooPayoutSelectionItem } from '../data/entities'

export const FINOO_PAYOUT_QUEUE = 'finoo-affiliates-payout-create'

export type FinooPayoutJobPayload = {
  progressJobId: string
  paymentReference: string
  affiliateUpdatedAt: string
  transactions: FinooPayoutSelectionItem[]
  tenantId: string
  organizationId: string
  userId: string
}

let payoutQueue: Queue<FinooPayoutJobPayload> | null = null

export function getFinooPayoutQueue(): Queue<FinooPayoutJobPayload> {
  payoutQueue ??= createModuleQueue<FinooPayoutJobPayload>(FINOO_PAYOUT_QUEUE, { concurrency: 3, attempts: 5 })
  return payoutQueue
}
