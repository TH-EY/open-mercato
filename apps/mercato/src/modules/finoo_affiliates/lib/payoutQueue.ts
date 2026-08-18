import { createModuleQueue, resolveQueueStrategy, type Queue } from '@open-mercato/queue'
import type { FinooPayoutSelectionItem } from '../data/entities'
import type { FinooPayoutConfirmGroupInput } from '../data/validators'

export const FINOO_PAYOUT_QUEUE = 'finoo-affiliates-payout-create'
export const FINOO_PAYOUT_MAX_ATTEMPTS = resolveQueueStrategy() === 'async' ? 5 : 3

type FinooPayoutJobScope = {
  progressJobId: string
  tenantId: string
  organizationId: string
  userId: string
  failureMessage?: string
}

export type FinooPayoutJobPayload = FinooPayoutJobScope & (
  | { batchId?: string; groups: FinooPayoutConfirmGroupInput[] }
  | {
      paymentReference: string
      affiliateUpdatedAt: string
      transactions: FinooPayoutSelectionItem[]
    }
)

export function payoutJobBatchId(payload: FinooPayoutJobPayload): string | null {
  return 'groups' in payload ? payload.batchId ?? null : null
}

export function payoutJobGroups(payload: FinooPayoutJobPayload): FinooPayoutConfirmGroupInput[] {
  return 'groups' in payload
    ? payload.groups
    : [{
        paymentReference: payload.paymentReference,
        affiliateUpdatedAt: payload.affiliateUpdatedAt,
        transactions: payload.transactions,
      }]
}

let payoutQueue: Queue<FinooPayoutJobPayload> | null = null

export function getFinooPayoutQueue(): Queue<FinooPayoutJobPayload> {
  payoutQueue ??= createModuleQueue<FinooPayoutJobPayload>(FINOO_PAYOUT_QUEUE, {
    concurrency: 3,
    attempts: 5,
  })
  return payoutQueue
}
