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

export type ProjectCreateInput = z.infer<typeof projectCreateSchema>
export type ProjectUpdateInput = z.infer<typeof projectUpdateSchema>
export type ProjectTaskCreateInput = z.infer<typeof projectTaskCreateSchema>
export type ProjectTaskUpdateInput = z.infer<typeof projectTaskUpdateSchema>
export type ProjectTaskReorderInput = z.infer<typeof projectTaskReorderSchema>
