import { describe, expect, it } from '@jest/globals'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import features from '../../acl'
import defaultEncryptionMaps from '../../encryption'
import setup, {
  FINOO_AFFILIATE_TRANSACTION_STATUS_DICTIONARY_KEY,
  FINOO_COMMISSION_STATUS_DICTIONARY_KEY,
} from '../../setup'
import {
  finooAffiliateProfileSchema,
  finooAffiliateTransactionStatusSchema,
  finooPayoutSelectionSchema,
} from '../validators'

describe('Finoo affiliate phase 1 contracts', () => {
  it('keeps the legacy dictionary separate from the new transaction lifecycle', () => {
    expect(FINOO_COMMISSION_STATUS_DICTIONARY_KEY).toBe('finoo_commission_status')
    expect(FINOO_AFFILIATE_TRANSACTION_STATUS_DICTIONARY_KEY).toBe('finoo_affiliate_transaction_status')
    expect(finooAffiliateTransactionStatusSchema.options).toEqual([
      'processing',
      'approved',
      'rejected',
      'paid_out',
    ])
  })

  it('limits payout selection and normalizes profile fields', () => {
    const item = { id: '11111111-1111-4111-8111-111111111111', updatedAt: '2026-08-13T10:00:00.000Z' }
    expect(finooPayoutSelectionSchema.parse([item])).toEqual([item])
    expect(finooPayoutSelectionSchema.safeParse([]).success).toBe(false)
    expect(finooPayoutSelectionSchema.safeParse(Array.from({ length: 101 }, () => item)).success).toBe(false)
    expect(finooAffiliateProfileSchema.parse({
      accountHolderName: '  Jan Kowalski  ',
      accountNumber: '  PL001122  ',
      updatedAt: item.updatedAt,
    })).toEqual({
      accountHolderName: 'Jan Kowalski',
      accountNumber: 'PL001122',
      updatedAt: item.updatedAt,
    })
  })

  it('declares additive staff and portal grants', () => {
    expect(features.map((feature) => feature.id)).toEqual(expect.arrayContaining([
      'finoo_affiliates.view',
      'finoo_affiliates.manage',
      'finoo_affiliates.payouts.manage',
      'portal.finoo_affiliates.view',
      'portal.finoo_affiliates.profile.manage',
    ]))
    expect(setup.defaultRoleFeatures?.employee).toEqual(['finoo_affiliates.view'])
    expect(setup.defaultCustomerRoleFeatures?.affiliate).toEqual([
      'portal.finoo_affiliates.view',
      'portal.finoo_affiliates.profile.manage',
    ])
  })

  it('encrypts affiliate PII and financial snapshots', () => {
    const affiliate = defaultEncryptionMaps.find((map) => map.entityId === 'finoo_affiliates:finoo_affiliate')
    const transaction = defaultEncryptionMaps.find((map) => map.entityId === 'finoo_affiliates:finoo_affiliate_transaction')
    const payout = defaultEncryptionMaps.find((map) => map.entityId === 'finoo_affiliates:finoo_affiliate_payout')

    expect(affiliate?.fields).toEqual(expect.arrayContaining([
      { field: 'email', hashField: 'email_hash' },
      { field: 'account_holder_name' },
      { field: 'account_number' },
    ]))
    expect(transaction?.fields).toEqual(expect.arrayContaining([
      { field: 'deal_name' },
      { field: 'deal_company' },
    ]))
    expect(payout?.fields).toEqual(expect.arrayContaining([
      { field: 'account_holder_name' },
      { field: 'account_number' },
    ]))
  })

  it('captures only the first post-deployment Accepted transition', () => {
    const migration = readFileSync(resolve(
      process.cwd(),
      'src/modules/finoo_affiliates/migrations/Migration20260813134051_finoo_affiliates.ts',
    ), 'utf8')

    expect(migration).toContain("lower(btrim(new.stage_label)) = 'accepted'")
    expect(migration).toContain('on conflict (tenant_id, organization_id, deal_id) do nothing')
    expect(migration).toContain('after insert or update of stage_label, transitioned_at')
    expect(migration).toContain('finoo_affiliates_code_format_check')
    expect(migration).toContain('finoo_affiliate_transactions_payout_id_foreign')
    expect(migration).not.toContain('insert into finoo_affiliate_transactions')
  })
})
