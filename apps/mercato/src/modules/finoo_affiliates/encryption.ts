import type { ModuleEncryptionMap } from '@open-mercato/shared/modules/encryption'

export const defaultEncryptionMaps: ModuleEncryptionMap[] = [
  {
    entityId: 'finoo_affiliates:finoo_deal_attribution',
    fields: [
      { field: 'company_name' },
      { field: 'landing_page' },
      { field: 'initial_referrer' },
    ],
  },
  {
    entityId: 'finoo_affiliates:finoo_affiliate',
    fields: [
      { field: 'email', hashField: 'email_hash' },
      { field: 'account_holder_name' },
      { field: 'account_number' },
    ],
  },
  {
    entityId: 'finoo_affiliates:finoo_affiliate_transaction',
    fields: [
      { field: 'deal_name' },
      { field: 'deal_company' },
    ],
  },
  {
    entityId: 'finoo_affiliates:finoo_affiliate_payout',
    fields: [
      { field: 'account_holder_name' },
      { field: 'account_number' },
    ],
  },
]

export default defaultEncryptionMaps
