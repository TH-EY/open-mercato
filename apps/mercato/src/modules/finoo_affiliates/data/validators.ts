import { z } from 'zod'

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
