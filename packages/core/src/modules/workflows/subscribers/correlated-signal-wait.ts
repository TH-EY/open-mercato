import type { EntityManager } from '@mikro-orm/core'
import type { AwilixContainer } from 'awilix'

export const metadata = {
  id: 'workflows:correlated-signal-wait',
  event: '*',
  persistent: true,
}

interface SubscriberContext {
  resolve: <T = unknown>(name: string) => T
  eventName?: string
  tenantId?: string | null
  organizationId?: string | null
}

export default async function handle(payload: unknown, ctx: SubscriberContext): Promise<void> {
  const eventName = typeof ctx.eventName === 'string' && ctx.eventName.length > 0
    ? ctx.eventName
    : null
  const tenantId = typeof ctx.tenantId === 'string' && ctx.tenantId.length > 0
    ? ctx.tenantId
    : null
  const organizationId = typeof ctx.organizationId === 'string' && ctx.organizationId.length > 0
    ? ctx.organizationId
    : null
  if (!eventName || !tenantId || !organizationId) return
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return

  const workflowOrigin = (payload as Record<string, unknown>)._workflow
  if (
    workflowOrigin &&
    typeof workflowOrigin === 'object' &&
    !Array.isArray(workflowOrigin) &&
    typeof (workflowOrigin as Record<string, unknown>).workflowInstanceId === 'string'
  ) {
    // EMIT_EVENT activities carry this platform-owned provenance marker. They
    // remain useful for ordinary workflow events, but cannot impersonate an
    // authoritative domain mutation to consume a correlated wait.
    return
  }

  const em = ctx.resolve<EntityManager>('em')
  const container = {
    resolve: ctx.resolve,
    cradle: new Proxy({}, {
      get: (_target, property: string) => ctx.resolve(property),
    }),
  } as unknown as AwilixContainer
  const { processCorrelatedSignalEvent } = await import('../lib/signal-handler')

  await processCorrelatedSignalEvent(em, container, {
    eventName,
    payload: payload as Record<string, unknown>,
    tenantId,
    organizationId,
  })
}
