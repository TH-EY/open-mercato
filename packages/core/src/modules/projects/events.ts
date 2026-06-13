import { createModuleEvents } from '@open-mercato/shared/modules/events'

const events = [
  { id: 'projects.project.created', label: 'Project Created', entity: 'project', category: 'crud' },
  { id: 'projects.project.updated', label: 'Project Updated', entity: 'project', category: 'crud' },
  { id: 'projects.project.deleted', label: 'Project Deleted', entity: 'project', category: 'crud' },
  { id: 'projects.task.created', label: 'Project Task Created', entity: 'task', category: 'crud' },
  { id: 'projects.task.updated', label: 'Project Task Updated', entity: 'task', category: 'crud' },
  { id: 'projects.task.deleted', label: 'Project Task Deleted', entity: 'task', category: 'crud' },
  { id: 'projects.task.moved', label: 'Project Task Moved', entity: 'task', category: 'lifecycle' },
  { id: 'projects.project.created_from_template', label: 'Project Created From Template', entity: 'project', category: 'lifecycle' },
  { id: 'projects.task_template.created', label: 'Project Task Template Created', entity: 'task_template', category: 'crud' },
  { id: 'projects.task_template.updated', label: 'Project Task Template Updated', entity: 'task_template', category: 'crud' },
  { id: 'projects.task_template.deleted', label: 'Project Task Template Deleted', entity: 'task_template', category: 'crud' },
  { id: 'projects.project_template.created', label: 'Project Template Created', entity: 'project_template', category: 'crud' },
  { id: 'projects.project_template.updated', label: 'Project Template Updated', entity: 'project_template', category: 'crud' },
  { id: 'projects.project_template.deleted', label: 'Project Template Deleted', entity: 'project_template', category: 'crud' },
  { id: 'projects.project_template.task.created', label: 'Project Template Task Created', entity: 'project_template_task', category: 'crud' },
  { id: 'projects.project_template.task.updated', label: 'Project Template Task Updated', entity: 'project_template_task', category: 'crud' },
  { id: 'projects.project_template.task.deleted', label: 'Project Template Task Deleted', entity: 'project_template_task', category: 'crud' },
] as const

export const eventsConfig = createModuleEvents({
  moduleId: 'projects',
  events,
})

export const emitProjectsEvent = eventsConfig.emit

export type ProjectsEventId = typeof events[number]['id']

export default eventsConfig
