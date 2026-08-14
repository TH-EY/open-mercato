import { resolveAffiliateCommissionSnapshot } from '../commission'

describe('resolveAffiliateCommissionSnapshot', () => {
  it('preserves the legacy Deal-attribution commission when no affiliate rule exists', () => {
    expect(resolveAffiliateCommissionSnapshot({
      commissionMode: null,
      commissionRateBps: null,
      commissionFixedAmount: null,
      attributionCommissionAmount: 275,
      dealValueAmount: null,
      dealValueCurrency: null,
    })).toEqual({
      commissionAmount: 275,
      commissionMode: 'legacy_deal_amount',
      commissionRateBps: null,
      commissionFixedAmount: null,
      commissionBaseAmount: null,
    })
  })

  it('snapshots a fixed whole-PLN commission', () => {
    expect(resolveAffiliateCommissionSnapshot({
      commissionMode: 'fixed',
      commissionRateBps: null,
      commissionFixedAmount: 450,
      attributionCommissionAmount: 20,
      dealValueAmount: '12345.67',
      dealValueCurrency: 'PLN',
    })).toEqual({
      commissionAmount: 450,
      commissionMode: 'fixed',
      commissionRateBps: null,
      commissionFixedAmount: 450,
      commissionBaseAmount: null,
    })
  })

  it.each([
    { amount: '1000.00', rateBps: 750, expected: 75 },
    { amount: '1234.56', rateBps: 750, expected: 93 },
    { amount: '100.00', rateBps: 50, expected: 1 },
    { amount: '99.99', rateBps: 50, expected: 0 },
    { amount: '21474836.47', rateBps: 10_000, expected: 21_474_836 },
  ])('calculates $rateBps basis points from $amount PLN with half-up whole-PLN rounding', ({ amount, rateBps, expected }) => {
    expect(resolveAffiliateCommissionSnapshot({
      commissionMode: 'percentage',
      commissionRateBps: rateBps,
      commissionFixedAmount: null,
      attributionCommissionAmount: 20,
      dealValueAmount: amount,
      dealValueCurrency: 'PLN',
    })).toEqual({
      commissionAmount: expected,
      commissionMode: 'percentage',
      commissionRateBps: rateBps,
      commissionFixedAmount: null,
      commissionBaseAmount: amount,
    })
  })

  it.each([
    { dealValueAmount: null, dealValueCurrency: 'PLN' },
    { dealValueAmount: '-1.00', dealValueCurrency: 'PLN' },
    { dealValueAmount: '1.001', dealValueCurrency: 'PLN' },
    { dealValueAmount: 'not-money', dealValueCurrency: 'PLN' },
    { dealValueAmount: '100.00', dealValueCurrency: null },
    { dealValueAmount: '100.00', dealValueCurrency: 'EUR' },
  ])('rejects an invalid percentage base %#', ({ dealValueAmount, dealValueCurrency }) => {
    expect(() => resolveAffiliateCommissionSnapshot({
      commissionMode: 'percentage',
      commissionRateBps: 750,
      commissionFixedAmount: null,
      attributionCommissionAmount: 20,
      dealValueAmount,
      dealValueCurrency,
    })).toThrow('[internal] A percentage affiliate commission requires a non-negative PLN Deal value')
  })

  it.each([
    { commissionMode: 'percentage' as const, commissionRateBps: null, commissionFixedAmount: null },
    { commissionMode: 'percentage' as const, commissionRateBps: 0, commissionFixedAmount: null },
    { commissionMode: 'percentage' as const, commissionRateBps: 10_001, commissionFixedAmount: null },
    { commissionMode: 'fixed' as const, commissionRateBps: null, commissionFixedAmount: null },
    { commissionMode: 'fixed' as const, commissionRateBps: null, commissionFixedAmount: -1 },
  ])('rejects an invalid stored rule %#', (rule) => {
    expect(() => resolveAffiliateCommissionSnapshot({
      ...rule,
      attributionCommissionAmount: 20,
      dealValueAmount: '100.00',
      dealValueCurrency: 'PLN',
    })).toThrow('[internal] Invalid affiliate commission rule')
  })

  it('rejects a calculated amount that cannot fit the transaction integer column', () => {
    expect(() => resolveAffiliateCommissionSnapshot({
      commissionMode: 'percentage',
      commissionRateBps: 10_000,
      commissionFixedAmount: null,
      attributionCommissionAmount: 20,
      dealValueAmount: '999999999999.99',
      dealValueCurrency: 'PLN',
    })).toThrow('[internal] Affiliate commission exceeds the supported amount')
  })
})
