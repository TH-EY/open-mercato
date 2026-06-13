import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { normalizeProjectTaskStatus, type ProjectTaskStatus } from './statuses'

export type ResolvedProjectTemplateTask = {
  name: string
  status: ProjectTaskStatus
  description: string | null
  ownerUserId: string | null
  dueInDays: number | null
  position: number
}

export type TaskTemplateSource = {
  name?: string | null
  status?: string | null
  description?: string | null
  ownerUserId?: string | null
  dueInDays?: number | null
}

export type ProjectTemplateTaskSource = {
  name?: string | null
  status?: string | null
  description?: string | null
  ownerUserId?: string | null
  dueInDays?: number | null
  position?: number | null
  taskTemplate?: TaskTemplateSource | null
}

function pickTemplateValue<T>(overrideValue: T | null | undefined, templateValue: T | null | undefined): T | null {
  return overrideValue !== undefined && overrideValue !== null ? overrideValue : templateValue ?? null
}

export function resolveProjectTemplateTask(source: ProjectTemplateTaskSource): ResolvedProjectTemplateTask {
  const name = pickTemplateValue(source.name, source.taskTemplate?.name)
  if (!name || !name.trim()) {
    throw new CrudHttpError(400, { error: 'Project template task must resolve to a task name.' })
  }
  const status = normalizeProjectTaskStatus(pickTemplateValue(source.status, source.taskTemplate?.status) ?? 'todo')
  const dueInDays = pickTemplateValue(source.dueInDays, source.taskTemplate?.dueInDays)
  return {
    name: name.trim(),
    status,
    description: pickTemplateValue(source.description, source.taskTemplate?.description),
    ownerUserId: pickTemplateValue(source.ownerUserId, source.taskTemplate?.ownerUserId),
    dueInDays,
    position: Math.max(0, Math.trunc(Number(source.position ?? 0))),
  }
}

export function deadlineFromDueInDays(baseDate: Date, dueInDays: number | null | undefined): Date | null {
  if (dueInDays === null || dueInDays === undefined) return null
  const deadline = new Date(baseDate)
  deadline.setUTCDate(deadline.getUTCDate() + dueInDays)
  return deadline
}
