import { buildPayoutBinding } from '../payouts'

describe('payout binding', () => {
  const input = {
    selection: [
      { id: '00000000-0000-4000-8000-000000000002', updatedAt: '2026-08-13T12:00:00.000Z' },
      { id: '00000000-0000-4000-8000-000000000001', updatedAt: '2026-08-13T11:00:00.000Z' },
    ],
    affiliateId: '00000000-0000-4000-8000-000000000003',
    affiliateUpdatedAt: '2026-08-13T10:00:00.000Z',
    amount: '9007199254740993',
    currency: 'PLN',
    profileHash: 'profile-hash',
  }

  it('is canonical across selection order and preserves decimal-string money', () => {
    expect(buildPayoutBinding(input)).toBe(buildPayoutBinding({ ...input, selection: [...input.selection].reverse() }))
  })

  it('changes for every exact selection, version, amount, affiliate, or profile binding', () => {
    const original = buildPayoutBinding(input)
    expect(buildPayoutBinding({ ...input, amount: '9007199254740994' })).not.toBe(original)
    expect(buildPayoutBinding({ ...input, profileHash: 'changed' })).not.toBe(original)
    expect(buildPayoutBinding({ ...input, selection: [{ ...input.selection[0], updatedAt: '2026-08-13T12:00:01.000Z' }, input.selection[1]] })).not.toBe(original)
  })
})
