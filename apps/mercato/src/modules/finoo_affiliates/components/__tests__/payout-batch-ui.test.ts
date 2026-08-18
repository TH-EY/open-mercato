import { normalizePayoutPreview } from '../payout-preview-dialog.client'
import { payoutErrorMessage } from '../payout-error'

const group = {
  paymentReference: 'FINOO-REF',
  affiliateId: '00000000-0000-4000-8000-000000000001',
  affiliateEmail: 'affiliate@example.com',
  affiliateUpdatedAt: '2026-08-13T10:00:00.000Z',
  accountHolderName: 'Affiliate',
  accountNumber: 'PL001',
  amount: '100',
  currency: 'PLN' as const,
  selectedCount: 1,
  transactions: [{ id: '00000000-0000-4000-8000-000000000002', updatedAt: '2026-08-13T11:00:00.000Z' }],
  expiresAt: '2026-08-13T11:15:00.000Z',
}

describe('payout batch UI contracts', () => {
  const t = (_key: string, fallback: string) => fallback

  it('normalizes the legacy flat preview into one group', () => {
    expect(normalizePayoutPreview(group)).toEqual({
      batchId: null, groups: [group], selectedCount: 1, affiliateCount: 1, totalAmount: '100', currency: 'PLN',
    })
  })

  it('lists every incomplete affiliate and missing field safely', () => {
    const error = Object.assign(new Error('failed'), {
      error: 'PAYOUT_PROFILES_INCOMPLETE',
      affiliates: [
        { affiliateEmail: 'first@example.com', missingFields: ['accountHolderName'] },
        { affiliateEmail: 'second@example.com', missingFields: ['accountNumber'] },
      ],
      status: 409,
    })
    expect(payoutErrorMessage(error, t)).toBe(
      'Complete payout profiles before continuing: first@example.com: account holder; second@example.com: account number',
    )
  })
})
