import { createSalesOrderLineDraft } from '../SalesOrderDraftLines'

describe('createSalesOrderLineDraft', () => {
  it('preserves the service identifier in draft records', () => {
    const serviceId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'

    const draft = createSalesOrderLineDraft(
      {
        kind: 'service',
        serviceId,
        quantity: 1,
        currencyCode: 'EUR',
        unitPriceNet: 1200,
        unitPriceGross: 1200,
      },
      'draft-service-line',
    )

    expect(draft.record.serviceId).toBe(serviceId)
    expect(draft.payload.serviceId).toBe(serviceId)
  })
})
