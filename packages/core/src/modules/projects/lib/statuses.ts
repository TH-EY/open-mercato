import { z } from 'zod'

export const projectTaskStatuses = ['todo', 'in_progress', 'done'] as const

export type ProjectTaskStatus = typeof projectTaskStatuses[number]

export const projectTaskStatusSchema = z.enum(projectTaskStatuses)

export const projectTaskStatusLabels: Record<ProjectTaskStatus, string> = {
  todo: 'Todo',
  in_progress: 'In progress',
  done: 'Done',
}

export function isProjectTaskStatus(value: unknown): value is ProjectTaskStatus {
  return typeof value === 'string' && projectTaskStatuses.includes(value as ProjectTaskStatus)
}

export function normalizeProjectTaskStatus(value: unknown): ProjectTaskStatus {
  return isProjectTaskStatus(value) ? value : 'todo'
}
