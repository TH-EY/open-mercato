import { z } from 'zod'

export const finooAffiliateCodeSchema = z.string().regex(/^[A-Z0-9]{24}$/)

export const finooAffiliateTransactionStatusSchema = z.enum([
  'processing',
  'approved',
  'rejected',
  'paid_out',
])

export const finooAffiliateTransactionActionSchema = z.enum([
  'accept',
  'reject',
  'reprocess',
])

export const finooAffiliateTransactionTransitionSchema = z.object({
  action: finooAffiliateTransactionActionSchema,
  updatedAt: z.string().datetime(),
})

export const finooAffiliateTransactionsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  sortField: z.enum(['acceptedAt', 'commissionAmount', 'commissionStatus']).default('acceptedAt'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
  status: finooAffiliateTransactionStatusSchema.optional(),
})

export const finooAffiliateProfileSchema = z.object({
  accountHolderName: z.string().trim().max(200),
  accountNumber: z.string().trim().max(64),
  updatedAt: z.string().datetime(),
})

export const finooPayoutSelectionItemSchema = z.object({
  id: z.string().uuid(),
  updatedAt: z.string().datetime(),
})

export const finooPayoutSelectionSchema = z.array(finooPayoutSelectionItemSchema).min(1).max(100)

export const finooPayoutPreviewSchema = z.object({
  transactions: finooPayoutSelectionSchema,
})

export const finooPayoutConfirmSchema = z.object({
  paymentReference: z.string().trim().min(1).max(100),
  affiliateUpdatedAt: z.string().datetime(),
  transactions: finooPayoutSelectionSchema,
})

export const finooPayoutsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
})

export const finooAffiliateLinkCreateSchema = z.object({
  affiliateUserId: z.string().uuid(),
  label: z.string().trim().min(1).max(160),
  destinationUrl: z.string().url().max(2048),
  isActive: z.boolean().optional().default(true),
})

export const finooAffiliateLinkUpdateSchema = finooAffiliateLinkCreateSchema.partial().extend({
  id: z.string().uuid(),
})

export const finooAffiliateLinkDeleteSchema = z.object({
  id: z.string().uuid(),
})

export const finooDealAttributionUpsertSchema = z.object({
  dealId: z.string().uuid(),
  affiliateUserId: z.string().uuid(),
  commissionStatusEntryId: z.string().uuid(),
  commissionAmount: z.coerce.number().int().min(0).max(2_147_483_647),
})

export const finooDashboardRangeSchema = z.object({
  from: z.string().date().optional(),
  to: z.string().date().optional(),
})

export const finooPortalLeadsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  sortField: z.enum(['leadAt', 'commissionAmount', 'commissionStatus']).default('leadAt'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
})

export type FinooAffiliateLinkCreateInput = z.infer<typeof finooAffiliateLinkCreateSchema>
export type FinooAffiliateLinkUpdateInput = z.infer<typeof finooAffiliateLinkUpdateSchema>
export type FinooDealAttributionUpsertInput = z.infer<typeof finooDealAttributionUpsertSchema>
export type FinooAffiliateProfileInput = z.infer<typeof finooAffiliateProfileSchema>
export type FinooAffiliateTransactionStatus = z.infer<typeof finooAffiliateTransactionStatusSchema>
export type FinooAffiliateTransactionAction = z.infer<typeof finooAffiliateTransactionActionSchema>
export type FinooAffiliateTransactionTransitionInput = z.infer<typeof finooAffiliateTransactionTransitionSchema>
export type FinooPayoutSelectionInput = z.infer<typeof finooPayoutSelectionSchema>
export type FinooPayoutPreviewInput = z.infer<typeof finooPayoutPreviewSchema>
export type FinooPayoutConfirmInput = z.infer<typeof finooPayoutConfirmSchema>
