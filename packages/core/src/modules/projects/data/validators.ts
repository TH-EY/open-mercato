import { z } from 'zod'
import { projectTaskStatusSchema } from '../lib/statuses'

const scopedCreateFields = {
  tenantId: z.string().uuid(),
  organizationId: z.string().uuid(),
}

const scopedUpdateFields = {
  id: z.string().uuid(),
}

const nullableUuid = z.string().uuid().optional().nullable()

export const projectCreateSchema = z.object({
  ...scopedCreateFields,
  name: z.string().trim().min(1),
  orderId: nullableUuid,
  ownerUserId: nullableUuid,
  isActive: z.boolean().optional(),
  templateId: nullableUuid,
})

export const projectUpdateSchema = z.object({
  ...scopedUpdateFields,
  name: z.string().trim().min(1).optional(),
  orderId: nullableUuid,
  ownerUserId: nullableUuid,
  isActive: z.boolean().optional(),
})

export const projectTaskCreateSchema = z.object({
  ...scopedCreateFields,
  projectId: z.string().uuid(),
  name: z.string().trim().min(1),
  status: projectTaskStatusSchema.default('todo'),
  description: z.string().optional().nullable(),
  ownerUserId: nullableUuid,
  deadlineAt: z.coerce.date().optional().nullable(),
  position: z.coerce.number().int().min(0).optional(),
})

export const projectTaskUpdateSchema = z.object({
  ...scopedUpdateFields,
  projectId: z.string().uuid().optional(),
  name: z.string().trim().min(1).optional(),
  status: projectTaskStatusSchema.optional(),
  description: z.string().optional().nullable(),
  ownerUserId: nullableUuid,
  deadlineAt: z.coerce.date().optional().nullable(),
  position: z.coerce.number().int().min(0).optional(),
})

export const projectTaskReorderSchema = z.object({
  projectId: z.string().uuid(),
  moves: z.array(z.object({
    id: z.string().uuid(),
    status: projectTaskStatusSchema,
    position: z.coerce.number().int().min(0),
  })).min(1),
})

const dueInDaysSchema = z.coerce.number().int().min(0).max(3650).optional().nullable()

export const projectTaskTemplateCreateSchema = z.object({
  ...scopedCreateFields,
  name: z.string().trim().min(1),
  status: projectTaskStatusSchema.default('todo'),
  description: z.string().optional().nullable(),
  ownerUserId: nullableUuid,
  dueInDays: dueInDaysSchema,
  isActive: z.boolean().optional(),
})

export const projectTaskTemplateUpdateSchema = z.object({
  ...scopedUpdateFields,
  name: z.string().trim().min(1).optional(),
  status: projectTaskStatusSchema.optional(),
  description: z.string().optional().nullable(),
  ownerUserId: nullableUuid,
  dueInDays: dueInDaysSchema,
  isActive: z.boolean().optional(),
})

export const projectTemplateCreateSchema = z.object({
  ...scopedCreateFields,
  name: z.string().trim().min(1),
  description: z.string().optional().nullable(),
  isActive: z.boolean().optional(),
})

export const projectTemplateUpdateSchema = z.object({
  ...scopedUpdateFields,
  name: z.string().trim().min(1).optional(),
  description: z.string().optional().nullable(),
  isActive: z.boolean().optional(),
})

export const projectTemplateTaskCreateSchema = z.object({
  ...scopedCreateFields,
  projectTemplateId: z.string().uuid(),
  taskTemplateId: nullableUuid,
  name: z.string().trim().min(1).optional().nullable(),
  status: projectTaskStatusSchema.optional().nullable(),
  description: z.string().optional().nullable(),
  ownerUserId: nullableUuid,
  dueInDays: dueInDaysSchema,
  position: z.coerce.number().int().min(0).optional(),
})

export const projectTemplateTaskUpdateSchema = z.object({
  ...scopedUpdateFields,
  projectTemplateId: z.string().uuid().optional(),
  taskTemplateId: nullableUuid,
  name: z.string().trim().min(1).optional().nullable(),
  status: projectTaskStatusSchema.optional().nullable(),
  description: z.string().optional().nullable(),
  ownerUserId: nullableUuid,
  dueInDays: dueInDaysSchema,
  position: z.coerce.number().int().min(0).optional(),
})

export type ProjectCreateInput = z.infer<typeof projectCreateSchema>
export type ProjectUpdateInput = z.infer<typeof projectUpdateSchema>
export type ProjectTaskCreateInput = z.infer<typeof projectTaskCreateSchema>
export type ProjectTaskUpdateInput = z.infer<typeof projectTaskUpdateSchema>
export type ProjectTaskReorderInput = z.infer<typeof projectTaskReorderSchema>
export type ProjectTaskTemplateCreateInput = z.infer<typeof projectTaskTemplateCreateSchema>
export type ProjectTaskTemplateUpdateInput = z.infer<typeof projectTaskTemplateUpdateSchema>
export type ProjectTemplateCreateInput = z.infer<typeof projectTemplateCreateSchema>
export type ProjectTemplateUpdateInput = z.infer<typeof projectTemplateUpdateSchema>
export type ProjectTemplateTaskCreateInput = z.infer<typeof projectTemplateTaskCreateSchema>
export type ProjectTemplateTaskUpdateInput = z.infer<typeof projectTemplateTaskUpdateSchema>
