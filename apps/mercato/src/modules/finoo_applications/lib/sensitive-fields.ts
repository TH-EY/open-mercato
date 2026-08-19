function sensitiveSpecs(entityId: string, kind: string, keys: string[]) {
  return keys.map((key) => ({ entityId, key, kind }))
}

const consentPrefixes = [
  'tc_consent', 'email_consent', 'sms_consent', 'phone_consent', 'data_sharing_consent',
  'jdg_consent', 'legal_consent', 'nova_lend_property_community_consent',
]

export const FINOO_APPLICATION_SENSITIVE_FIELD_SPECS = [
  ...sensitiveSpecs('customers:customer_company_profile', 'text', ['tax_number']),
  ...sensitiveSpecs('customers:customer_person_profile', 'text', [
    'national_identification_number', 'mobile', 'id_number',
    ...consentPrefixes.flatMap((prefix) => [`${prefix}_source`, `${prefix}_consent_code`, `${prefix}_content`, `${prefix}_ip_address`]),
  ]),
  ...sensitiveSpecs('customers:customer_person_profile', 'date', ['id_issued_date', 'id_expiry_date']),
  ...sensitiveSpecs('customers:customer_person_profile', 'datetime', consentPrefixes.map((prefix) => `${prefix}_accepted_at`)),
  ...sensitiveSpecs('customers:customer_person_profile', 'boolean', consentPrefixes.map((prefix) => `${prefix}_accepted`)),
  ...sensitiveSpecs('customers:customer_deal', 'integer', ['amount', 'earnings']),
  ...sensitiveSpecs('customers:customer_deal', 'boolean', ['arrears']),
  ...sensitiveSpecs('customers:customer_deal', 'multiline', ['submission_history']),
  ...sensitiveSpecs('customers:customer_deal', 'text', ['nova_lend_status_reason', 'initial_referrer', 'last_referrer', 'landing_page']),
] as const
