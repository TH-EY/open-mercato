import { z } from 'zod'

export const partnerStatusSchema = z.enum(['new', 'in_progress', 'done'])
export const noteBodySchema = z.string().trim().min(1).max(10_000)
export const expectedUpdatedAtSchema = z.string().datetime({ offset: true })
export const intermediaryLifecycleStateSchema = z.enum(['delivery_failed', 'invited', 'active', 'inactive'])
export const effectiveIntermediaryStatusSchema = z.enum(['delivery_failed', 'invited', 'expired', 'active', 'inactive'])
export const intermediaryEmailKindSchema = z.enum(['invitation', 'access_notice'])
export const intermediaryEmailStatusSchema = z.enum(['pending', 'delivered', 'failed'])

const intermediaryNameSchema = z.string().trim().min(1).max(200)
const intermediaryEmailSchema = z.string().trim().email().max(320).transform((email) => email.toLowerCase())

export const intermediaryInviteSchema = z.object({
  email: intermediaryEmailSchema,
  firstName: intermediaryNameSchema,
  lastName: intermediaryNameSchema,
}).strict()

export const intermediaryUpdateSchema = z.object({
  firstName: intermediaryNameSchema,
  lastName: intermediaryNameSchema,
  email: intermediaryEmailSchema.optional(),
  expectedUpdatedAt: expectedUpdatedAtSchema,
}).strict()

export const intermediaryLifecycleActionSchema = z.object({
  expectedUpdatedAt: expectedUpdatedAtSchema,
}).strict()

export const assignmentCreateSchema = z.object({
  dealId: z.string().uuid(),
  intermediaryCustomerUserId: z.string().uuid(),
}).strict()

export const assignmentUpdateSchema = z.object({
  intermediaryCustomerUserId: z.string().uuid(),
  expectedUpdatedAt: expectedUpdatedAtSchema,
}).strict()

export const assignmentDeleteSchema = z.object({
  expectedUpdatedAt: expectedUpdatedAtSchema,
}).strict()

export const bulkAssignmentDealSchema = z.object({
  id: z.string().uuid(),
  updatedAt: expectedUpdatedAtSchema,
  assignmentId: z.string().uuid().nullable(),
  assignmentUpdatedAt: expectedUpdatedAtSchema.nullable(),
}).strict().superRefine((value, ctx) => {
  if ((value.assignmentId === null) !== (value.assignmentUpdatedAt === null)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Assignment id and version must both be present or absent',
    })
  }
})

export const bulkAssignmentRequestSchema = z.object({
  deals: z.array(bulkAssignmentDealSchema).min(1).max(100),
  intermediaryCustomerUserId: z.string().uuid(),
  confirmReassign: z.boolean().default(false),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.deals.map((deal) => deal.id)).size !== value.deals.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Deal ids must be unique', path: ['deals'] })
  }
  const assignmentIds = value.deals.flatMap((deal) => deal.assignmentId ? [deal.assignmentId] : [])
  if (new Set(assignmentIds).size !== assignmentIds.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Assignment ids must be unique', path: ['deals'] })
  }
})

export const bulkAssignmentCommandSchema = bulkAssignmentRequestSchema.extend({
  operationId: z.string().uuid(),
  tenantId: z.string().uuid(),
  organizationId: z.string().uuid(),
  actorUserId: z.string().uuid(),
})

export const partnerStatusUpdateSchema = z.object({
  status: partnerStatusSchema,
  expectedUpdatedAt: expectedUpdatedAtSchema,
}).strict()

export const noteCreateSchema = z.object({
  body: noteBodySchema,
}).strict()

export const noteUpdateSchema = z.object({
  body: noteBodySchema,
  expectedUpdatedAt: expectedUpdatedAtSchema,
}).strict()

export const noteDeleteSchema = z.object({
  expectedUpdatedAt: expectedUpdatedAtSchema,
}).strict()

export type AssignmentCreateInput = z.infer<typeof assignmentCreateSchema>
export type AssignmentUpdateInput = z.infer<typeof assignmentUpdateSchema>
export type BulkAssignmentDealInput = z.infer<typeof bulkAssignmentDealSchema>
export type BulkAssignmentRequestInput = z.infer<typeof bulkAssignmentRequestSchema>
export type BulkAssignmentCommandInput = z.infer<typeof bulkAssignmentCommandSchema>
export type PartnerStatusUpdateInput = z.infer<typeof partnerStatusUpdateSchema>
export type NoteCreateInput = z.infer<typeof noteCreateSchema>
export type NoteUpdateInput = z.infer<typeof noteUpdateSchema>
export type IntermediaryInviteInput = z.infer<typeof intermediaryInviteSchema>
export type IntermediaryUpdateInput = z.infer<typeof intermediaryUpdateSchema>
export type IntermediaryLifecycleActionInput = z.infer<typeof intermediaryLifecycleActionSchema>
