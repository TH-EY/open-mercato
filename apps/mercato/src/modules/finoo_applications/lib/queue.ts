import { createModuleQueue, resolveQueueStrategy, type Queue } from '@open-mercato/queue'

export const FINOO_APPLICATION_QUEUE = 'finoo-applications-project'
export const FINOO_APPLICATION_MAX_ATTEMPTS = resolveQueueStrategy() === 'async' ? 5 : 3

export type FinooApplicationJob = { intakeId: string; tenantId: string; organizationId: string }

let queue: Queue<FinooApplicationJob> | null = null

export function getFinooApplicationQueue(): Queue<FinooApplicationJob> {
  queue ??= createModuleQueue<FinooApplicationJob>(FINOO_APPLICATION_QUEUE, { concurrency: 2, attempts: 5 })
  return queue
}
