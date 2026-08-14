import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { finooAffiliateCommissionUpdateSchema } from '../validators'

const id = '11111111-1111-4111-8111-111111111111'
const updatedAt = '2026-08-14T10:00:00.000Z'

describe('Finoo affiliate commission contracts', () => {
  it('accepts only complete percentage or fixed settings', () => {
    expect(finooAffiliateCommissionUpdateSchema.parse({
      id,
      updatedAt,
      commissionMode: 'percentage',
      commissionRateBps: 750,
      commissionFixedAmount: null,
    })).toMatchObject({ commissionMode: 'percentage', commissionRateBps: 750 })
    expect(finooAffiliateCommissionUpdateSchema.parse({
      id,
      updatedAt,
      commissionMode: 'fixed',
      commissionRateBps: null,
      commissionFixedAmount: 450,
    })).toMatchObject({ commissionMode: 'fixed', commissionFixedAmount: 450 })
    expect(finooAffiliateCommissionUpdateSchema.safeParse({
      id,
      updatedAt,
      commissionMode: null,
      commissionRateBps: null,
      commissionFixedAmount: null,
    }).success).toBe(false)
    expect(finooAffiliateCommissionUpdateSchema.safeParse({
      id,
      updatedAt,
      commissionMode: 'percentage',
      commissionRateBps: 0,
      commissionFixedAmount: null,
    }).success).toBe(false)
  })

  it('keeps the migration compatible with old writers and preserves financial snapshots on down', () => {
    const migration = readFileSync(resolve(
      __dirname,
      '../../migrations/Migration20260814172130_finoo_affiliates.ts',
    ), 'utf8')

    expect(migration).toContain(`"commission_mode" text not null default 'legacy_deal_amount'`)
    expect(migration).toContain('deal_value_amount')
    expect(migration).toContain('deal_value_currency')
    expect(migration).toContain('create or replace function finoo_capture_first_deal_acceptance()')
    expect(migration).toContain('override down(): void {}')
    expect(migration).not.toContain('drop column')
  })
})
