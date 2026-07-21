import type { AwilixContainer } from 'awilix'
import type { SalesEventId } from '../events'

const QUOTE_STATUS_CHANGED_EVENT = 'sales.quote.status_changed' satisfies SalesEventId

export async function emitQuoteStatusChanged(
  container: AwilixContainer,
  quote: {
    id: string
    tenantId: string
    organizationId: string
    status?: string | null
    statusEntryId?: string | null
  },
  previousStatus: string | null,
  options?: { orderId?: string },
): Promise<boolean> {
  const status = quote.status ?? null
  if (previousStatus === status) return false

  const eventBus = container.resolve<{
    emitEvent(event: string, payload: Record<string, unknown>, options: Record<string, unknown>): Promise<void>
  }>('eventBus')

  await eventBus.emitEvent(
    QUOTE_STATUS_CHANGED_EVENT,
    {
      id: quote.id,
      previousStatus,
      status,
      statusEntryId: quote.statusEntryId ?? null,
      tenantId: quote.tenantId,
      organizationId: quote.organizationId,
      ...(options?.orderId ? { orderId: options.orderId } : {}),
    },
    {
      persistent: true,
      tenantId: quote.tenantId,
      organizationId: quote.organizationId,
    },
  )

  return true
}
