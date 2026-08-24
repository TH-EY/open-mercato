import { z } from 'zod'
import { IDENTITY_DOCUMENT_TYPES, validatePesel } from '../lib/identity-domain'

const documentTypeSchema = z.enum(Object.keys(IDENTITY_DOCUMENT_TYPES) as [keyof typeof IDENTITY_DOCUMENT_TYPES, ...(keyof typeof IDENTITY_DOCUMENT_TYPES)[]])
const optionalDateSchema = z.string().date().optional().nullable()

export const finooIdentityInputSchema = z.object({
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
})

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
