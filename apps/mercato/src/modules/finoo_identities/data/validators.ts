import { z } from 'zod'
import {
  fixedIdentityIssuingCountryCode,
  IDENTITY_DOCUMENT_TYPES,
  isIdentityDocumentType,
  normalizeIdentityIssuingCountryCode,
  validatePesel,
} from '../lib/identity-domain'

const documentTypeSchema = z.enum(Object.keys(IDENTITY_DOCUMENT_TYPES) as [keyof typeof IDENTITY_DOCUMENT_TYPES, ...(keyof typeof IDENTITY_DOCUMENT_TYPES)[]])
const optionalDateSchema = z.string().date().optional().nullable()

const finooIdentityInputObjectSchema = z.object({
  pesel: z.string().trim().min(1).max(32).transform((value) => value.replace(/\D/g, '')),
  documentType: documentTypeSchema.optional().nullable(),
  issuingCountryCode: z.string().trim().regex(/^[A-Za-z]{2}$/).transform((value) => value.toUpperCase()).optional().nullable(),
  documentNumber: z.string().trim().min(1).max(64).optional().nullable(),
  issuedOn: optionalDateSchema,
  expiresOn: optionalDateSchema,
}).strict().superRefine((value, context) => {
  if (!validatePesel(value.pesel).valid) {
    context.addIssue({ code: 'custom', path: ['pesel'], message: 'invalid_pesel' })
  }
  if (value.issuedOn && value.expiresOn && value.expiresOn < value.issuedOn) {
    context.addIssue({ code: 'custom', path: ['expiresOn'], message: 'expiry_before_issue_date' })
  }
  const fixedCountryCode = fixedIdentityIssuingCountryCode(value.documentType)
  if (fixedCountryCode !== null
    && value.issuingCountryCode !== null
    && value.issuingCountryCode !== undefined
    && value.issuingCountryCode !== fixedCountryCode) {
    context.addIssue({
      code: 'custom',
      path: ['issuingCountryCode'],
      message: 'invalid_issuing_country_for_document_type',
    })
  }
})

export const finooIdentityInputSchema = finooIdentityInputObjectSchema.transform((value) => ({
  ...value,
  issuingCountryCode: normalizeIdentityIssuingCountryCode(value.documentType, value.issuingCountryCode),
}))

export const finooIdentityFormSchema = z.preprocess((input) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input
  const values = input as Record<string, unknown>
  const documentType = typeof values.documentType === 'string' ? values.documentType : null
  if (!isIdentityDocumentType(documentType)
    || fixedIdentityIssuingCountryCode(documentType) === null) return input
  return { ...values, issuingCountryCode: null }
}, finooIdentityInputSchema)

export const finooIdentityConflictResolutionSchema = z.object({
  action: z.enum(['replace', 'dismiss']),
  updatedAt: z.string().datetime({ offset: true }),
  identityUpdatedAt: z.string().datetime({ offset: true }),
}).strict()

export const finooIdentityAuditListSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(50),
})

export const finooIdentityConflictListSchema = finooIdentityAuditListSchema.extend({
  personId: z.string().uuid(),
})

export type FinooIdentityInput = z.infer<typeof finooIdentityInputSchema>
export type FinooIdentityConflictResolutionInput = z.infer<typeof finooIdentityConflictResolutionSchema>
