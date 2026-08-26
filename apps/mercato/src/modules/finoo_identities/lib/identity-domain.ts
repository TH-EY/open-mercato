export type PeselValidationResult =
  | { valid: true; normalized: string }
  | { valid: false; normalized: string | null; reason: 'missing' | 'invalid' }

export const IDENTITY_DOCUMENT_TYPES = {
  identity_card: { requiresExpiryDate: true, fixedIssuingCountryCode: 'PL' },
  permanent_identity_card: { requiresExpiryDate: false, fixedIssuingCountryCode: 'PL' },
  passport: { requiresExpiryDate: true, fixedIssuingCountryCode: null },
  digital_identity_card: { requiresExpiryDate: true, fixedIssuingCountryCode: 'PL' },
} as const

export type IdentityDocumentType = keyof typeof IDENTITY_DOCUMENT_TYPES
export type IdentityFieldStatus = 'complete' | 'missing' | 'not_applicable'
export type IdentityFieldStatuses = {
  pesel: IdentityFieldStatus
  documentType: IdentityFieldStatus
  issuingCountryCode: IdentityFieldStatus
  documentNumber: IdentityFieldStatus
  issuedOn: IdentityFieldStatus
  expiresOn: IdentityFieldStatus
}

const IDENTITY_FIELD_STATUS_KEYS = [
  'pesel',
  'documentType',
  'issuingCountryCode',
  'documentNumber',
  'issuedOn',
  'expiresOn',
] as const

function safeIdentityFieldStatus(value: unknown): IdentityFieldStatus {
  return value === 'complete' || value === 'not_applicable' ? value : 'missing'
}

export function sanitizeIdentityFieldStatuses(value: unknown): IdentityFieldStatuses {
  const source = typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : {}
  return Object.fromEntries(
    IDENTITY_FIELD_STATUS_KEYS.map((key) => [key, safeIdentityFieldStatus(source[key])]),
  ) as IdentityFieldStatuses
}

export type IdentityDataInput = {
  pesel?: string | null
  documentType?: string | null
  issuingCountryCode?: string | null
  documentNumber?: string | null
  issuedOn?: string | Date | null
  expiresOn?: string | Date | null
}

export type IdentityCompleteness = {
  isComplete: boolean
  statuses: IdentityFieldStatuses
}

const PESEL_WEIGHTS = [1, 3, 7, 9, 1, 3, 7, 9, 1, 3] as const

function hasValidPeselBirthDate(pesel: string): boolean {
  const yearPart = Number(pesel.slice(0, 2))
  const encodedMonth = Number(pesel.slice(2, 4))
  const day = Number(pesel.slice(4, 6))
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
  const month = encodedMonth % 20
  const year = century + yearPart
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
}

function hasValidPeselChecksum(pesel: string): boolean {
  const sum = PESEL_WEIGHTS.reduce((total, weight, index) => total + Number(pesel[index]) * weight, 0)
  const checksum = (10 - (sum % 10)) % 10
  return checksum === Number(pesel[10])
}

export function validatePesel(value: string | null | undefined): PeselValidationResult {
  const normalized = value?.replace(/\D/g, '') ?? ''
  if (normalized.length === 0) return { valid: false, normalized: null, reason: 'missing' }
  if (normalized.length !== 11 || !hasValidPeselBirthDate(normalized) || !hasValidPeselChecksum(normalized)) {
    return { valid: false, normalized, reason: 'invalid' }
  }
  return { valid: true, normalized }
}

export function isIdentityDocumentType(value: string | null | undefined): value is IdentityDocumentType {
  return typeof value === 'string' && value in IDENTITY_DOCUMENT_TYPES
}

export function fixedIdentityIssuingCountryCode(
  documentType: string | null | undefined,
): 'PL' | null {
  return isIdentityDocumentType(documentType)
    ? IDENTITY_DOCUMENT_TYPES[documentType].fixedIssuingCountryCode
    : null
}

export function normalizeIdentityIssuingCountryCode(
  documentType: string | null | undefined,
  issuingCountryCode: string | null | undefined,
): string | null {
  const normalized = issuingCountryCode?.trim().toUpperCase() || null
  return normalized ?? fixedIdentityIssuingCountryCode(documentType)
}

function parseIdentityDate(value: string | Date | null | undefined): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? date
    : null
}

export function computeIdentityCompleteness(input: IdentityDataInput): IdentityCompleteness {
  const documentType = isIdentityDocumentType(input.documentType) ? input.documentType : null
  const issuedOn = parseIdentityDate(input.issuedOn)
  const expiresOn = parseIdentityDate(input.expiresOn)
  const requiresExpiryDate = documentType === null
    ? true
    : IDENTITY_DOCUMENT_TYPES[documentType].requiresExpiryDate
  const normalizedCountryCode = normalizeIdentityIssuingCountryCode(documentType, input.issuingCountryCode)
  const fixedCountryCode = fixedIdentityIssuingCountryCode(documentType)
  const hasValidCountryCode = normalizedCountryCode !== null
    && /^[A-Z]{2}$/.test(normalizedCountryCode)
    && (fixedCountryCode === null || normalizedCountryCode === fixedCountryCode)
  const statuses: IdentityFieldStatuses = {
    pesel: validatePesel(input.pesel).valid ? 'complete' : 'missing',
    documentType: documentType ? 'complete' : 'missing',
    issuingCountryCode: hasValidCountryCode ? 'complete' : 'missing',
    documentNumber: typeof input.documentNumber === 'string' && input.documentNumber.trim().length > 0 && input.documentNumber.trim().length <= 64
      ? 'complete'
      : 'missing',
    issuedOn: issuedOn ? 'complete' : 'missing',
    expiresOn: !requiresExpiryDate
      ? 'not_applicable'
      : expiresOn && (!issuedOn || expiresOn.getTime() >= issuedOn.getTime())
        ? 'complete'
        : 'missing',
  }
  return {
    isComplete: Object.values(statuses).every((status) => status !== 'missing'),
    statuses,
  }
}
