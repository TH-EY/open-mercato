import type { AwilixContainer } from 'awilix'
import { emitQuoteStatusChanged } from '../quoteStatusEvents'

describe('emitQuoteStatusChanged', () => {
  const quote = {
    id: '22222222-2222-4222-8222-222222222222',
    tenantId: '00000000-0000-4000-8000-000000000000',
    organizationId: '11111111-1111-4111-8111-111111111111',
    status: 'confirmed',
    statusEntryId: '33333333-3333-4333-8333-333333333333',
  }

  it('emits the persistent scoped event for a changed status value', async () => {
    const emitEvent = jest.fn().mockResolvedValue(undefined)
    const container = {
      resolve: jest.fn().mockReturnValue({ emitEvent }),
    } as unknown as AwilixContainer

    await expect(
      emitQuoteStatusChanged(container, quote, 'sent', { orderId: '44444444-4444-4444-8444-444444444444' }),
    ).resolves.toBe(true)

    expect(emitEvent).toHaveBeenCalledWith(
      'sales.quote.status_changed',
      {
        id: quote.id,
        previousStatus: 'sent',
        status: 'confirmed',
        statusEntryId: quote.statusEntryId,
        tenantId: quote.tenantId,
        organizationId: quote.organizationId,
        orderId: '44444444-4444-4444-8444-444444444444',
      },
      {
        persistent: true,
        tenantId: quote.tenantId,
        organizationId: quote.organizationId,
      },
    )
  })

  it('does not emit when only the status entry changes', async () => {
    const emitEvent = jest.fn().mockResolvedValue(undefined)
    const container = {
      resolve: jest.fn().mockReturnValue({ emitEvent }),
    } as unknown as AwilixContainer

    await expect(emitQuoteStatusChanged(container, quote, 'confirmed')).resolves.toBe(false)
    expect(emitEvent).not.toHaveBeenCalled()
  })
})
