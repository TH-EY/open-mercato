export const FINOO_CONSENT_REGISTRY_VERSION = 'finoo-apply-2026-08-19-7e72cbeb'

export const FINOO_CONSENT_REGISTRY_SOURCE = {
  page: 'https://finoo.pl/apply',
  capturedAt: '2026-08-24',
  appBundle: 'https://finoo.pl/assets/index-DcYdDW8y.js',
  appBundleSha256: 'd7476e2c3fdb801466fdde3494111db6df0892af4877082cd535daf7dbf81b',
  registrySha256: 'b53f8ffac9d0aaf4b82f3d48951082e1201c1e85ac1c2bbed5dca95edad95c3c',
} as const

const contactContent = 'Zgadzam się na kontakt FINOO.PL w sprawie tego wniosku, także jeśli go nie dokończę.'
const finooMarketingContent = 'Wyrażam zgodę na przesyłanie informacji handlowych przez FINOO.PL (opcjonalnie)'
const partnerMarketingContent = 'Wyrażam zgodę na przesyłanie informacji handlowych partnerów (opcjonalnie)'

export const FINOO_CONSENT_REGISTRY = {
  acceptTerms: {
    code: 'finoo_terms_and_privacy',
    content: 'Potwierdzam, że zapoznałem/am się z Regulamin (/documents/Regulamin_finoo.pdf) oraz Politykę Prywatności (/documents/Polityka_Prywatnosci_finoo.pdf) FINOO.PL i akceptuję ich treść.',
  },
  contactConsent: { code: 'finoo_application_contact', content: contactContent },
  contactEmail: { code: 'finoo_application_contact_email', content: `${contactContent} Kanał: E-mail.` },
  contactSms: { code: 'finoo_application_contact_sms', content: `${contactContent} Kanał: SMS.` },
  contactPhone: { code: 'finoo_application_contact_phone', content: `${contactContent} Kanał: Telefon.` },
  emailConsent: { code: 'finoo_marketing_email', content: `${finooMarketingContent} — E-mail.` },
  smsConsent: { code: 'finoo_marketing_sms', content: `${finooMarketingContent} — SMS.` },
  phoneConsent: { code: 'finoo_marketing_phone', content: `${finooMarketingContent} — Telefon.` },
  dataSharingEmail: { code: 'hill_capital_partners_email', content: `${partnerMarketingContent} — E-mail.` },
  dataSharingSms: { code: 'hill_capital_partners_sms', content: `${partnerMarketingContent} — SMS.` },
  dataSharingPhone: { code: 'hill_capital_partners_phone', content: `${partnerMarketingContent} — Telefon.` },
  jdg1: {
    code: 'novalend_jdg_bik_authorization',
    content: 'Upoważniam NovaLend Sp. z o.o. do wystąpienia do Biura Informacji Kredytowej S.A. o udostępnienie informacji, w tym objętych tajemnicą bankową.',
  },
  jdg2: {
    code: 'novalend_jdg_big_info_monitor',
    content: 'Upoważniam NovaLend Sp. z o.o. do przekazywania informacji gospodarczych do BIG InfoMonitor S.A.',
  },
  jdg3: {
    code: 'novalend_jdg_krd',
    content: 'Upoważniam NovaLend Sp. z o.o. do przekazywania informacji do Krajowego Rejestru Długów BIG S.A.',
  },
  legal1: {
    code: 'novalend_company_bik_authorization',
    content: 'Udzielam NovaLend Sp. z o.o. pełnomocnictwa do wystąpienia do Biura Informacji Kredytowej S.A. o udostępnienie informacji, w tym objętych tajemnicą bankową.',
  },
  legal2: {
    code: 'novalend_company_krd',
    content: 'Upoważniam NovaLend Sp. z o.o. do przekazywania informacji do Krajowego Rejestru Długów BIG S.A.',
  },
  propertyCommunity: { code: 'property_community_declaration', content: 'Posiadam wspólność majątkową.' },
} as const

type RegistryClauseKey = 'jdg1' | 'jdg2' | 'jdg3' | 'legal1' | 'legal2'

export function consentClauseMatchesRegistry(key: RegistryClauseKey, value: unknown): boolean {
  if (!value || typeof value !== 'object') return true
  const text = (value as Record<string, unknown>).text
  if (text === undefined) return true
  return typeof text === 'string' && text === FINOO_CONSENT_REGISTRY[key].content
}
