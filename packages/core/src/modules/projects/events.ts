import { createModuleEvents } from '@open-mercato/shared/modules/events'

const events = [
  { id: 'projects.project.created', label: 'Project Created', entity: 'project', category: 'crud' },
  { id: 'projects.project.updated', label: 'Project Updated', entity: 'project', category: 'crud' },
  { id: 'projects.project.deleted', label: 'Project Deleted', entity: 'project', category: 'crud' },
  { id: 'projects.task.created', label: 'Project Task Created', entity: 'task', category: 'crud' },
  { id: 'projects.task.updated', label: 'Project Task Updated', entity: 'task', category: 'crud' },
  { id: 'projects.task.deleted', label: 'Project Task Deleted', entity: 'task', category: 'crud' },
  { id: 'projects.task.moved', label: 'Project Task Moved', entity: 'task', category: 'lifecycle' },
] as const

export const eventsConfig = createModuleEvents({
  moduleId: 'projects',
  events,
})

export const emitProjectsEvent = eventsConfig.emit

export type ProjectsEventId = typeof events[number]['id']

export default eventsConfig
