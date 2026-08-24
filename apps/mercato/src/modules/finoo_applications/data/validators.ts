import { parseBooleanToken } from '@open-mercato/shared/lib/boolean'
import { isIP } from 'node:net'
import { z } from 'zod'
import { consentClauseMatchesRegistry, FINOO_CONSENT_REGISTRY_VERSION } from '../lib/consents'

const MAX_UNKNOWN_FIELD_NAMES = 50
const MAX_REPRESENTATIVES = 20
const LEAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/
const SAFE_UNKNOWN_FIELD_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
const PESEL_WEIGHTS = [1, 3, 7, 9, 1, 3, 7, 9, 1, 3] as const

const optionalText = (max: number) => z.string().trim().max(max).optional()

export function isValidPesel(value: string): boolean {
  const pesel = value.replace(/\D/g, '')
  if (pesel.length !== 11) return false
  const encodedMonth = Number(pesel.slice(2, 4))
  const century = encodedMonth >= 81 && encodedMonth <= 92
    ? 1800
    : encodedMonth >= 1 && encodedMonth <= 12
      ? 1900
      : encodedMonth >= 21 && encodedMonth <= 32
        ? 2000
        : encodedMonth >= 41 && encodedMonth <= 52
          ? 2100
          : encodedMonth >= 61 && encodedMonth <= 72
            ? 2200
            : null
  if (century === null) return false
  const year = century + Number(pesel.slice(0, 2))
  const month = encodedMonth % 20
  const day = Number(pesel.slice(4, 6))
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return false
  const sum = PESEL_WEIGHTS.reduce((total, weight, index) => total + Number(pesel[index]) * weight, 0)
  return (10 - (sum % 10)) % 10 === Number(pesel[10])
}

const formBooleanSchema = z.union([z.boolean(), z.string().trim().max(16)]).transform((value, context) => {
  if (typeof value === 'boolean') return value
  const parsed = parseBooleanToken(value)
  if (parsed !== null) return parsed
  context.addIssue({ code: 'custom', message: 'Invalid boolean token' })
  return z.NEVER
})

const consentClauseSchema = z.object({
  selected: formBooleanSchema,
}).strip()

const representativeSchema = z.object({
  firstname: z.string().trim().min(1).max(100),
  lastname: z.string().trim().min(1).max(100),
  email: z.string().trim().email().max(320),
})

const representativesInputSchema = z.union([
  z.array(representativeSchema).max(MAX_REPRESENTATIVES),
  z.string().max(20_000).transform((value, context) => {
    try {
      return z.array(representativeSchema).max(MAX_REPRESENTATIVES).parse(JSON.parse(value))
    } catch {
      context.addIssue({ code: 'custom', message: 'Invalid representatives payload' })
      return z.NEVER
    }
  }),
])

const rawApplicationObjectSchema = z.object({
  leadId: z.string().trim().regex(LEAD_ID_PATTERN),
  consentVersion: z.literal(FINOO_CONSENT_REGISTRY_VERSION).optional(),
  completed: z.boolean(),
  leadType: z.literal('business').optional(),
  name: optionalText(100),
  surname: optionalText(100),
  pesel: optionalText(32),
  phone: optionalText(32),
  phonePrefix: optionalText(8),
  mobile: optionalText(32),
  mobilePrefix: optionalText(8),
  email: z.string().trim().email().max(320).optional().or(z.literal('')),
  position: optionalText(200),
  companyName: optionalText(200),
  nip: optionalText(32),
  companyNip: optionalText(32),
  businessStartDate: z.string().date().optional().or(z.literal('')),
  earnings: optionalText(32),
  amount: optionalText(32),
  months: optionalText(16),
  reason: optionalText(4_000),
  idType: z.enum(['IDCARD', 'PASSPORT', 'DIGITCARD']).optional(),
  idCard: optionalText(64),
  idCardIssued: z.string().date().optional().or(z.literal('')),
  idCardExpiry: z.string().date().optional().or(z.literal('')),
  passport: optionalText(64),
  passportCountryCode: optionalText(2),
  passportIssued: z.string().date().optional().or(z.literal('')),
  passportExpiry: z.string().date().optional().or(z.literal('')),
  digitCard: optionalText(64),
  digitCardIssued: z.string().date().optional().or(z.literal('')),
  digitCardExpiry: z.string().date().optional().or(z.literal('')),
  country: optionalText(2),
  businessType: z.enum(['jdg', 'company']).optional(),
  arrearsUsZus: formBooleanSchema.optional(),
  contactConsent: formBooleanSchema.optional(),
  contactEmail: formBooleanSchema.optional(),
  contactSms: formBooleanSchema.optional(),
  contactPhone: formBooleanSchema.optional(),
  emailConsent: formBooleanSchema.optional(),
  smsConsent: formBooleanSchema.optional(),
  telefonConsent: formBooleanSchema.optional(),
  acceptTerms: formBooleanSchema.optional(),
  emailConsent2: formBooleanSchema.optional(),
  smsConsent2: formBooleanSchema.optional(),
  telefonConsent2: formBooleanSchema.optional(),
  jdgConsent: z.object({
    jdg1: consentClauseSchema.optional(),
    jdg2: consentClauseSchema.optional(),
    jdg3: consentClauseSchema.optional(),
  }).strict().optional(),
  legalConsent: z.object({
    legal1: consentClauseSchema.optional(),
    legal2: consentClauseSchema.optional(),
  }).strict().optional(),
  'NovaLend-propertyCommunity': formBooleanSchema.optional(),
  representatives: representativesInputSchema.optional(),
  kontomatikCompleted: formBooleanSchema.optional(),
  kontomatikToken: z.string().max(20_000).optional(),
  disqualified: formBooleanSchema.optional(),
  disqualification_message: optionalText(4_000),
  affiliate_code: optionalText(128),
  utm_source: optionalText(200),
  utm_medium: optionalText(200),
  utm_campaign: optionalText(500),
  utm_term: optionalText(500),
  utm_content: optionalText(500),
  first_utm_source: optionalText(200),
  first_utm_medium: optionalText(200),
  first_utm_campaign: optionalText(500),
  gclid: optionalText(500),
  fbclid: optionalText(500),
  msclkid: optionalText(500),
  landingPage: optionalText(2_048),
  initialReferrer: optionalText(2_048),
  lastReferrer: optionalText(2_048),
  session_started_at: optionalText(64),
  first_touch_at: optionalText(64),
  last_touch_at: optionalText(64),
  traffic_source: optionalText(500),
}).strip()

const allowedRawKeys = new Set(Object.keys(rawApplicationObjectSchema.shape))

function validateFinalSubmission(
  value: z.infer<typeof rawApplicationObjectSchema>,
  context: z.RefinementCtx,
): void {
  const completed = value.completed === true
  const hasConsentDecision = [
    value.emailConsent,
    value.smsConsent,
    value.telefonConsent,
    value.acceptTerms,
    value.contactConsent,
    value.contactEmail,
    value.contactSms,
    value.contactPhone,
    value.emailConsent2,
    value.smsConsent2,
    value.telefonConsent2,
    value['NovaLend-propertyCommunity'],
    ...Object.values(value.jdgConsent ?? {}).map((clause) => clause?.selected),
    ...Object.values(value.legalConsent ?? {}).map((clause) => clause?.selected),
  ].some((decision) => decision !== undefined)
  if ((completed || hasConsentDecision) && value.consentVersion !== FINOO_CONSENT_REGISTRY_VERSION) {
    context.addIssue({ code: 'custom', path: ['consentVersion'], message: 'Current consent version is required when consent is present' })
  }
  if (value.disqualified && !completed) {
    context.addIssue({ code: 'custom', path: ['completed'], message: 'Completed must be true for a disqualified submission' })
  }
  if (!completed) return
  const required: Array<keyof typeof value> = ['companyName', 'name', 'surname']
  for (const field of required) {
    if (!value[field]) context.addIssue({ code: 'custom', path: [field], message: 'Required for final submission' })
  }
  const nip = value.companyNip || value.nip
  if (!nip) context.addIssue({ code: 'custom', path: ['nip'], message: 'Required for final submission' })
  if (nip && nip.replace(/\D/g, '').length !== 10) {
    context.addIssue({ code: 'custom', path: ['nip'], message: 'NIP must contain 10 digits' })
  }
  if (!value.pesel) {
    context.addIssue({ code: 'custom', path: ['pesel'], message: 'PESEL is required for final submission' })
  } else if (!isValidPesel(value.pesel)) {
    context.addIssue({ code: 'custom', path: ['pesel'], message: 'PESEL is invalid' })
  }
}

export const finooApplicationPayloadSchema = rawApplicationObjectSchema.superRefine(validateFinalSubmission)

export type FinooApplicationPayload = z.infer<typeof finooApplicationPayloadSchema>

export type SanitizedFinooApplicationPayload = Omit<FinooApplicationPayload, 'kontomatikToken'> & {
  ingestionMeta: {
    messageId: string
    sourceTimestamp: number
    receivedAt: string
    sourceIp?: string
    unknownFieldNames: string[]
    kontomatikTokenDiscarded: boolean
  }
}

export function parseAndSanitizeFinooApplicationPayload(
  input: unknown,
  metadata: { messageId: string; sourceTimestamp: number; receivedAt: string; sourceIp?: string },
): SanitizedFinooApplicationPayload {
  const source = input && typeof input === 'object' ? input as Record<string, unknown> : {}
  const jdg = source.jdgConsent && typeof source.jdgConsent === 'object' ? source.jdgConsent as Record<string, unknown> : {}
  const legal = source.legalConsent && typeof source.legalConsent === 'object' ? source.legalConsent as Record<string, unknown> : {}
  if (!consentClauseMatchesRegistry('jdg1', jdg.jdg1)
    || !consentClauseMatchesRegistry('jdg2', jdg.jdg2)
    || !consentClauseMatchesRegistry('jdg3', jdg.jdg3)
    || !consentClauseMatchesRegistry('legal1', legal.legal1)
    || !consentClauseMatchesRegistry('legal2', legal.legal2)) {
    throw new Error('consent_registry_mismatch')
  }
  const parsed = finooApplicationPayloadSchema.parse(input)
  const unknownFieldNames = Object.keys(source)
    .filter((key) => !allowedRawKeys.has(key))
    .filter((key) => SAFE_UNKNOWN_FIELD_PATTERN.test(key))
    .sort()
    .slice(0, MAX_UNKNOWN_FIELD_NAMES)
  const { kontomatikToken: discardedToken, ...sanitized } = parsed
  return {
    ...sanitized,
    ingestionMeta: {
      messageId: metadata.messageId,
      sourceTimestamp: metadata.sourceTimestamp,
      receivedAt: metadata.receivedAt,
      ...(metadata.sourceIp && isIP(metadata.sourceIp) !== 0 ? { sourceIp: metadata.sourceIp } : {}),
      unknownFieldNames,
      kontomatikTokenDiscarded: typeof discardedToken === 'string' && discardedToken.length > 0,
    },
  }
}

export const sanitizedFinooApplicationPayloadSchema = rawApplicationObjectSchema.omit({
  kontomatikToken: true,
}).superRefine(validateFinalSubmission).and(z.object({
  ingestionMeta: z.object({
    messageId: z.string().min(16).max(128),
    sourceTimestamp: z.number().int().nonnegative(),
    receivedAt: z.string().datetime({ offset: true }),
    sourceIp: z.string().refine((value) => isIP(value) !== 0, 'Invalid IP address').optional(),
    unknownFieldNames: z.array(z.string().regex(SAFE_UNKNOWN_FIELD_PATTERN)).max(MAX_UNKNOWN_FIELD_NAMES),
    kontomatikTokenDiscarded: z.boolean(),
  }),
}))
