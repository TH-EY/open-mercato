import { z } from 'zod'

export const partnerStatusSchema = z.enum(['new', 'in_progress', 'done'])
export const noteBodySchema = z.string().trim().min(1).max(10_000)
export const expectedUpdatedAtSchema = z.string().datetime({ offset: true })

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
export type PartnerStatusUpdateInput = z.infer<typeof partnerStatusUpdateSchema>
export type NoteCreateInput = z.infer<typeof noteCreateSchema>
export type NoteUpdateInput = z.infer<typeof noteUpdateSchema>
