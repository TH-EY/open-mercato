export const FINOO_CONSENT_REGISTRY_VERSION = 'finoo-apply-2026-08-18-44a3f0bb'

export const FINOO_CONSENT_REGISTRY_SOURCE = {
  page: 'https://finoo.pl/apply',
  capturedAt: '2026-08-18',
  applyBundleSha256: '44a3f0bbe22918fd891b2a14ba569ef175c86bcc22f5b778456a4d3bb658c7fc',
  clausesBundleSha256: '9c75fb79458d08c797cccf753ac3c60016a77d5b9042bf15d8f00fa6a08cc7b2',
} as const

// Preserve the source bundle byte-for-byte, including its malformed href, until legal approves a new registry version.
const fullTextLink = " <a href='Szybki kredyt dla firm do 400 000 zł target='_blank'>Pełna Treść</a>"

export const FINOO_CONSENT_REGISTRY = {
  acceptTerms: {
    code: 'finoo_terms_and_privacy',
    content: 'Potwierdzam, że zapoznałem/am się z Regulaminem (/documents/Regulamin_finoo.pdf) oraz Polityką Prywatności (/documents/Polityka_Prywatnosci_finoo.pdf) FINOO.PL i akceptuję ich treść.',
  },
  emailConsent: { code: 'finoo_contact_or_marketing_email', content: 'Zgoda na kontakt lub informacje handlowe FINOO.PL — E-mail.' },
  smsConsent: { code: 'finoo_contact_or_marketing_sms', content: 'Zgoda na kontakt lub informacje handlowe FINOO.PL — SMS.' },
  phoneConsent: { code: 'finoo_contact_or_marketing_phone', content: 'Zgoda na kontakt lub informacje handlowe FINOO.PL — Telefon.' },
  dataSharingEmail: { code: 'hill_capital_partners_email', content: 'Wyrażam zgodę na przesyłanie informacji handlowych partnerów Hill Capital — E-mail.' },
  dataSharingSms: { code: 'hill_capital_partners_sms', content: 'Wyrażam zgodę na przesyłanie informacji handlowych partnerów Hill Capital — SMS.' },
  dataSharingPhone: { code: 'hill_capital_partners_phone', content: 'Wyrażam zgodę na przesyłanie informacji handlowych partnerów Hill Capital — Telefon.' },
  jdg: {
    code: 'novalend_jdg_disclosure_and_bik_mandate',
    content: `Upoważniam Novalend Sp. z o.o. do ujawnienia lub/i przekazywania informacji gospodarczych dotyczących mojej osoby oraz firmy, którą reprezentuję. W związku ze złożeniem przeze mnie wniosku o pożyczkę, niniejszym udzielam NovaLend Sp. z o.o. pełnomocnictwa do wystąpienia w moim imieniu do Biura Informacji Kredytowej S.A. o udostępnienie informacji, w tym stanowiących tajemnicę bankową oraz do złożenia w moim imieniu oświadczenia, dotyczącego przetwarzania moich danych osobowych o treści następującej:${fullTextLink}`,
  },
  jdg1: {
    code: 'novalend_big_info_monitor',
    content: `Upoważniam Novalend Sp. z o.o. do ujawnienia lub/i przekazywania informacji gospodarczych dotyczących mojej osoby do Biura Informacji Gospodarczej InfoMonitor S.A. z siedzibą w Warszawie (ul. Zygmunta Modzelewskiego 77a, 02-679 Warszawa):${fullTextLink}`,
  },
  jdg2: {
    code: 'novalend_krd',
    content: 'Upoważniam Novalend Sp. z o.o. do ujawnienia lub/i przekazywania informacji gospodarczych dotyczących mojej osoby oraz firmy, którą reprezentuję do Krajowego Rejestru Długów Biura Informacji Gospodarczej S.A. z siedzibą we Wrocławiu (ul. Danuty Siedzikówny 12, 51-214 Wrocław)',
  },
  legal: {
    code: 'novalend_bik_mandate',
    content: `W związku ze złożeniem przeze mnie wniosku o pożyczkę, niniejszym udzielam NovaLend Sp. z o.o. pełnomocnictwa do wystąpienia w moim imieniu do Biura Informacji Kredytowej S.A. o udostępnienie informacji, w tym stanowiących tajemnicę bankową oraz do złożenia w moim imieniu oświadczenia, dotyczącego przetwarzania moich danych osobowych o treści następującej:${fullTextLink}`,
  },
  legal1: {
    code: 'novalend_krd',
    content: 'Upoważniam Novalend Sp. z o.o. do ujawnienia lub/i przekazywania informacji gospodarczych dotyczących mojej osoby oraz firmy, którą reprezentuję do Krajowego Rejestru Długów Biura Informacji Gospodarczej S.A. z siedzibą we Wrocławiu (ul. Danuty Siedzikówny 12, 51-214 Wrocław)',
  },
  propertyCommunity: { code: 'property_community_declaration', content: 'Posiadam wspólność majątkową.' },
} as const

type RegistryClauseKey = 'jdg' | 'jdg1' | 'jdg2' | 'legal' | 'legal1'

export function consentClauseMatchesRegistry(key: RegistryClauseKey, value: unknown): boolean {
  if (!value || typeof value !== 'object') return true
  const text = (value as Record<string, unknown>).text
  return typeof text === 'string' && text === FINOO_CONSENT_REGISTRY[key].content
}
