# Projects Module

## Summary

Add a first-class `projects` module for project tracking linked to Sales Orders. Projects are organization-scoped and contain project-scoped tasks displayed on a Kanban board.

## Scope

- `Project` with `name`, optional `orderId`, optional `ownerUserId`, scope fields, active flag, timestamps, and soft delete.
- `ProjectTask` with `projectId`, `name`, `status`, `description`, optional `ownerUserId`, optional `deadlineAt`, `position`, scope fields, timestamps, and soft delete.
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

## Access Control

- `projects.view`
- `projects.manage`
- `projects.tasks.manage`
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

## Integration Coverage

- API coverage should create its own Sales Order fixture, create/update/delete a Project, create/update/delete ProjectTasks, verify order scoping, and verify task reorder persistence.
- UI coverage should verify Projects table navigation, project creation linked to a Sales Order, task creation from the board, status move, within-column reorder, task edit fields, attachment upload, reload persistence.

## Backward Compatibility

This is an additive module. It adds new routes, ACL feature IDs, entity IDs, events, and database tables without changing existing contract surfaces.
