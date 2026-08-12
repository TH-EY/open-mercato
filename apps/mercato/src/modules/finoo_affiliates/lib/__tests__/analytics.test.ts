import { loadFinooDashboard, resolveFinooAnalyticsRange } from '../analytics'

describe('Finoo affiliate analytics range', () => {
  const previousTimezone = process.env.OM_FINOO_ANALYTICS_TIMEZONE

  beforeAll(() => {
    process.env.OM_FINOO_ANALYTICS_TIMEZONE = 'Europe/Warsaw'
  })

  afterAll(() => {
    if (previousTimezone === undefined) delete process.env.OM_FINOO_ANALYTICS_TIMEZONE
    else process.env.OM_FINOO_ANALYTICS_TIMEZONE = previousTimezone
  })

  it('defaults to the last 30 calendar days in the configured timezone', () => {
    const range = resolveFinooAnalyticsRange({}, new Date('2026-08-12T10:00:00Z'))
    expect(range.from).toBe('2026-07-14')
    expect(range.to).toBe('2026-08-12')
    expect(range.timezone).toBe('Europe/Warsaw')
  })

  it('accepts a 366-day inclusive range and rejects reversed or longer ranges', () => {
    expect(resolveFinooAnalyticsRange({ from: '2025-01-01', to: '2026-01-01' }).from).toBe('2025-01-01')
    expect(() => resolveFinooAnalyticsRange({ from: '2026-01-02', to: '2026-01-01' })).toThrow()
    expect(() => resolveFinooAnalyticsRange({ from: '2025-01-01', to: '2026-01-02' })).toThrow()
  })

  it('zero-fills weekly series returned by the aggregate queries', async () => {
    const execute = jest.fn()
      .mockResolvedValueOnce([{ week_start: '2026-08-03', count: 2 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ week_start: '2026-08-10', count: 1 }])
    const em = { getConnection: () => ({ execute }) }
    const range = resolveFinooAnalyticsRange({ from: '2026-08-03', to: '2026-08-16' })

    const result = await loadFinooDashboard(
      em as never,
      '00000000-0000-4000-8000-000000000001',
      {
        tenantId: '00000000-0000-4000-8000-000000000002',
        organizationId: '00000000-0000-4000-8000-000000000003',
      },
      range,
    )

    expect(result.leads).toEqual([
      { weekStart: '2026-08-03', count: 2 },
      { weekStart: '2026-08-10', count: 0 },
    ])
    expect(result.clicks).toEqual([
      { weekStart: '2026-08-03', count: 0 },
      { weekStart: '2026-08-10', count: 0 },
    ])
    expect(result.transactions).toEqual([
      { weekStart: '2026-08-03', count: 0 },
      { weekStart: '2026-08-10', count: 1 },
    ])
  })
})
