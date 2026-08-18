import { buildPayoutBatchBinding, buildPayoutBinding } from '../payouts'
import { finooPayoutConfirmSchema, normalizePayoutConfirmGroups } from '../../data/validators'

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

describe('payout batch validation', () => {
  const batchId = '00000000-0000-4000-8000-000000000010'
  const group = {
    paymentReference: 'FINOO-REF-1',
    affiliateUpdatedAt: '2026-08-13T10:00:00.000Z',
    transactions: [{ id: '00000000-0000-4000-8000-000000000001', updatedAt: '2026-08-13T11:00:00.000Z' }],
  }

  it('keeps the legacy single-group request as a compatibility bridge', () => {
    const parsed = finooPayoutConfirmSchema.parse(group)
    expect(normalizePayoutConfirmGroups(parsed)).toEqual([group])
  })

  it('accepts multiple exact groups and rejects duplicate transactions', () => {
    const second = {
      ...group,
      paymentReference: 'FINOO-REF-2',
      transactions: [{ id: '00000000-0000-4000-8000-000000000002', updatedAt: '2026-08-13T12:00:00.000Z' }],
    }
    expect(normalizePayoutConfirmGroups(finooPayoutConfirmSchema.parse({ batchId, groups: [group, second] }))).toEqual([group, second])
    expect(finooPayoutConfirmSchema.safeParse({ batchId, groups: [group, { ...second, transactions: group.transactions }] }).success).toBe(false)
    expect(finooPayoutConfirmSchema.safeParse({ groups: [group, second] }).success).toBe(false)
  })

  it('limits the complete batch to 100 transactions', () => {
    const transactions = Array.from({ length: 101 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      updatedAt: '2026-08-13T11:00:00.000Z',
    }))
    expect(finooPayoutConfirmSchema.safeParse({
      batchId,
      groups: [
        { ...group, transactions: transactions.slice(0, 51) },
        { ...group, paymentReference: 'FINOO-REF-2', transactions: transactions.slice(51) },
      ],
    }).success).toBe(false)
  })

  it('binds the exact server-issued batch independently of group order', () => {
    const bindingInput = {
      batchId,
      scope: { tenantId: 'tenant', organizationId: 'organization' },
      groups: [
        { paymentReference: 'FINOO-REF-2', bindingHash: 'binding-2' },
        { paymentReference: 'FINOO-REF-1', bindingHash: 'binding-1' },
      ],
    }
    expect(buildPayoutBatchBinding(bindingInput)).toBe(buildPayoutBatchBinding({
      ...bindingInput,
      groups: [...bindingInput.groups].reverse(),
    }))
  })
})
