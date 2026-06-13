# Projects Module

## Summary

Add a first-class `projects` module for project tracking linked to Sales Orders. Projects are organization-scoped and contain project-scoped tasks displayed on a Kanban board.

## Scope

- `Project` with `name`, optional `orderId`, optional `ownerUserId`, scope fields, active flag, timestamps, and soft delete.
- `ProjectTask` with `projectId`, `name`, `status`, `description`, optional `ownerUserId`, optional `deadlineAt`, `position`, scope fields, timestamps, and soft delete.
- `ProjectTaskTemplate` with reusable task preset fields: `name`, `status`, `description`, optional `ownerUserId`, optional relative `dueInDays`, active flag, scope fields, timestamps, and soft delete.
- `ProjectTemplate` with `name`, `description`, active flag, scope fields, timestamps, and soft delete.
- `ProjectTemplateTask` with `projectTemplateId`, optional `taskTemplateId`, override fields for task metadata, `position`, scope fields, timestamps, and soft delete.
- Fixed v1 task statuses: `todo`, `in_progress`, `done`, isolated in module status helpers for later dictionary-backed migration.
- No direct ORM relationship to Sales Orders or Auth users; references are UUID fields validated within tenant/organization scope.
- Backend pages:
  - `/backend/projects`
  - `/backend/projects/create`
  - `/backend/projects/[id]`
- APIs:
  - `GET/POST/PUT/DELETE /api/projects`
  - `GET/POST/PUT/DELETE /api/projects/tasks`
  - `POST /api/projects/tasks/reorder`
  - `GET/POST/PUT/DELETE /api/projects/task-templates`
  - `GET/POST/PUT/DELETE /api/projects/templates`
  - `GET/POST/PUT/DELETE /api/projects/templates/tasks`
- Project create accepts optional `templateId`; when provided, project creation atomically creates tasks from the selected project template. Template `dueInDays` values are converted to real task `deadlineAt` values relative to project creation time.

## Access Control

- `projects.view`
- `projects.manage`
- `projects.tasks.manage`
- `projects.templates.manage`
- Admin default: `projects.*`
- Employee default: `projects.view`, `projects.tasks.manage`

## Events

- `projects.project.created`
- `projects.project.updated`
- `projects.project.deleted`
- `projects.task.created`
- `projects.task.updated`
- `projects.task.deleted`
- `projects.task.moved`
- `projects.project.created_from_template`
- `projects.task_template.created`
- `projects.task_template.updated`
- `projects.task_template.deleted`
- `projects.project_template.created`
- `projects.project_template.updated`
- `projects.project_template.deleted`
- `projects.project_template.task.created`
- `projects.project_template.task.updated`
- `projects.project_template.task.deleted`

## Integration Coverage

- API coverage should create its own Sales Order fixture, create/update/delete a Project, create/update/delete ProjectTasks, verify order scoping, and verify task reorder persistence.
- API coverage should create/update/delete task templates, project templates, and project template tasks; create a project from a template; assert task status, position, owner, description, and relative deadline persistence; and verify soft-deleted templates cannot be used for project creation.
- ACL coverage should verify `projects.templates.manage` is required for template administration and not granted to employee defaults.
- UI coverage should verify Projects table navigation, project creation linked to a Sales Order, task creation from the board, status move, within-column reorder, task edit fields, attachment upload, reload persistence.
- UI coverage should verify task template creation, project template creation with reusable/inline task rows, project creation from a selected template, generated task display on Kanban, and employee denial for template screens.

## Backward Compatibility

This is an additive module. It adds new routes, ACL feature IDs, entity IDs, events, and database tables without changing existing contract surfaces.
