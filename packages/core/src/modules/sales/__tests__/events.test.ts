import eventsConfig from '../events'

describe('sales event catalog', () => {
  it('declares the Quote status-changed lifecycle signal', () => {
    expect(eventsConfig.events).toContainEqual(
      expect.objectContaining({
        id: 'sales.quote.status_changed',
        label: 'Quote Status Changed',
        entity: 'quote',
        category: 'lifecycle',
      }),
    )
  })
})
