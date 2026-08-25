import { z } from 'zod'
import { FINOO_CUSTOMER_RETENTION_STATUSES } from './entities'

const nullableDateSchema = z.coerce.date().nullable()

export const finooCustomerRetentionStatusSchema = z.enum(FINOO_CUSTOMER_RETENTION_STATUSES)
export const finooCustomerRetentionWindowSchema = z.number().int().min(1).max(3650).nullable()
export const finooCustomerRetentionSettingsChangeSchema = z.object({
  inactivityWindowDays: finooCustomerRetentionWindowSchema,
  previewToken: z.string().min(1).max(512).optional(),
})

export const finooCustomerRetentionPreviewSchema = z.object({
  inactivityWindowDays: z.number().int().min(1).max(3650),
})

export const finooCustomerRetentionSettingsSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  organizationId: z.string().uuid(),
  inactivityWindowDays: finooCustomerRetentionWindowSchema,
  previewTokenHash: z.string().length(64).nullable(),
  previewWindowDays: z.number().int().min(1).max(3650).nullable(),
  previewTotalEligible: z.number().int().nonnegative().nullable(),
  previewNewlyExpired: z.number().int().nonnegative().nullable(),
  previewAlreadyExpired: z.number().int().nonnegative().nullable(),
  previewExpiresAt: nullableDateSchema,
  reconciliationGeneration: z.number().int().nonnegative(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
})

export const finooCustomerRetentionStateSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  organizationId: z.string().uuid(),
  customerEntityId: z.string().uuid(),
  retentionStatus: finooCustomerRetentionStatusSchema,
  eligibilityAnchorAt: z.coerce.date(),
  lastQualifyingActivityAt: nullableDateSchema,
  retentionExpiresAt: nullableDateSchema,
  expiredAt: nullableDateSchema,
  identityErasedAt: nullableDateSchema,
  lastEvaluatedAt: z.coerce.date(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  deletedAt: nullableDateSchema,
})

export type FinooCustomerRetentionSettingsInput = z.infer<typeof finooCustomerRetentionSettingsSchema>
export type FinooCustomerRetentionStateInput = z.infer<typeof finooCustomerRetentionStateSchema>
export type FinooCustomerRetentionSettingsChangeInput = z.infer<typeof finooCustomerRetentionSettingsChangeSchema>
