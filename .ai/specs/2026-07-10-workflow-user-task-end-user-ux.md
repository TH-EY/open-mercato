---
title: Workflow User Task End-User UX
date: 2026-07-10
status: ready
module: workflows
---

# Workflow User Task End-User UX

## TLDR

Workflow `USER_TASK` steps become a coherent end-user capability: an eligible operational user discovers an assigned or role-queue task, understands its business context, safely claims or completes it, and resumes the workflow without entering workflow administration screens.

The EPC-first delivery combines one server-side authorization contract with three entry surfaces: a true personal task inbox, an actionable assignment notification, and a compact workflow-task widget on the related sales deal. The exact EPC revision is deployed and proven before any public contribution is considered in a separate Jira issue and branch.

## Overview

Open Mercato already pauses a workflow instance when a `USER_TASK` step creates a task. The runtime primitive works, but the operational experience is fragmented across workflow administration, an inbox that does not actually send `myTasks=true`, and a notification contract that is never emitted and links to a nonexistent route.

The target experience is:

```text
Open sales deal
      ↓
"Initial contact is waiting for action"
      ↓
[Claim task] → [Complete Initial contact]
      ↓
Workflow resumes at Quotation
```

Users should not need to understand workflow definitions or instances. Administrators retain definition and instance administration, while operational users receive only the minimum permissions and only see or mutate tasks they are eligible to perform.

This follows established task-worker patterns: task candidates may discover and claim group tasks, only the assignee completes a claimed task, assignment notifications provide a direct entry point, and broad process administration is separate from performing work. Reference behavior: [Camunda user task authorization](https://docs.camunda.io/docs/components/tasklist/user-task-authorization/), [managing tasks](https://docs.camunda.io/docs/components/tasklist/userguide/managing-tasks/), and [user task lifecycle](https://docs.camunda.io/docs/apis-tools/frontend-development/task-applications/user-task-lifecycle/).

## Problem Statement

The engine correctly pauses at `USER_TASK`, but operational users cannot reliably discover or act on the task:

- default operational roles do not receive task execution features;
- page metadata uses frozen `workflows.view_tasks`, while APIs use `workflows.tasks.*`;
- the UI defaults the `My tasks` control to true but omits the query parameter;
- role-queue tasks claimed by another user remain visible to all role members;
- detail, claim, and completion do not consistently enforce task ownership;
- claim currently lacks tenant and organization scope, creating an ID-based write risk;
- claim and complete are read-then-write operations that can race;
- `workflows.task.assigned` is neither declared nor emitted;
- notification links target `/backend/workflows/tasks/{id}` instead of `/backend/tasks/{id}`;
- task responses expose a workflow-instance UUID rather than useful source context;
- the sales deal page has no task CTA.

The result is an admin-oriented experience with insufficient server-side authorization, even though the workflow itself is behaving as designed.

## Proposed Solution

Define a single reusable task-access policy in the workflows module and apply it to list, detail, claim, and complete operations. The policy is scoped by tenant, organization, actor, direct assignment, role candidacy, and claim ownership.

Keep task execution in the workflows module. Resolve source entity metadata from the workflow instance in the same module, and use widget injection for optional deal UI. No direct ORM relationship or mandatory `customers` dependency is introduced.

### Task ownership contract

| Operation | Direct assignment | Role queue | Workflow manager |
|---|---|---|---|
| Personal list | active task where `assignedTo === actorId` | unclaimed `PENDING` task where actor has a candidate role, or active task where `claimedBy === actorId` | the same performer-only predicate; management never broadens `myTasks=true` |
| Broad list/detail inspection | not applicable | not applicable | all tasks in current tenant/organization only when the actor has `workflows.manage` |
| Personal detail | task matching the personal performer predicate | task matching the personal performer predicate | manager may inspect any scoped task but cannot thereby perform it |
| Claim | not applicable | `PENDING`, unclaimed, actor has a candidate role | same candidate rule; management alone does not perform the task |
| Complete | `PENDING` or `IN_PROGRESS` and actor is direct assignee | task is `IN_PROGRESS` and `claimedBy === actorId` | no implicit override; manager must be an eligible performer |

The API returns `404` for tasks outside scope or eligibility to avoid disclosing their existence. A stale claim or duplicate completion returns `409`. Only the successful transaction emits the task event or resumes the workflow.

`PENDING` and `IN_PROGRESS` are active statuses. `COMPLETED` and `CANCELLED` tasks remain available only in explicit history/admin queries and never drive an actionable deal widget. Direct assignment and role candidacy are mutually exclusive: if a valid `assignedTo` is present, `assignedToRoles` is normalized to `null` and direct ownership wins.

### Design decisions

1. **Claim-first for role queues.** A candidate must claim a shared task before completing it, preventing two users from acting on the same step.
2. **No implicit admin execution override.** `workflows.manage` grants administration, not permission to perform another user's work. Admins used in demonstrations must also be eligible by assignment or role.
3. **Direct assignments can complete immediately.** A needless claim step is not added when ownership is already singular.
4. **Same-module context join.** Task APIs may read `WorkflowInstance.metadata.entityType/entityId`; the deal widget never needs instance-administration permission.
5. **Additive compatibility.** Existing URLs, entities, ACL IDs, notification type IDs, and widget spots remain stable.
6. **Direct notification in the first EPC release.** A direct assignee is notified after durable task creation. Role-queue notification fan-out is deferred until recipient resolution can enforce organization visibility; candidates still discover role tasks in My Tasks and on the deal.
7. **Navigation counter is not implemented by hard-coding a static badge.** The current menu-injection contract accepts only static badge values. EPC gets a top-level My Tasks entry, the real list total, deal CTA, and notification count. A dynamic sidebar badge requires a generic menu-data contract and belongs in the separate upstream follow-up.
8. **Broad listing is manager-only.** `myTasks=true` always uses the performer predicate, even for managers. Omitting or disabling it requires `workflows.manage`; otherwise the API returns `403` rather than silently exposing the organization queue.
9. **Form-bearing tasks open their detail form.** The deal widget completes only tasks with no required form input. If `formSchema` requires user input, its CTA is `Open task` and routes to `/backend/tasks/{id}`.

### Alternatives considered

- **Insert `WAIT_FOR_SIGNAL` after every user task:** rejected because `USER_TASK` already pauses the instance; it would create a second unrelated resume condition.
- **Use a guard failure to pause:** rejected because failure and waiting are different runtime states and would degrade monitoring and retry semantics.
- **Expose all tasks and hide actions in React:** rejected because it leaks task metadata and is bypassable through direct API calls.
- **Add a customers-to-workflows ORM relationship:** rejected by module-decoupling rules and unnecessary because workflow instance metadata already carries the source identity.
- **Notify every tenant user with a matching role name:** rejected for the EPC first release because role membership alone does not prove organization visibility.

## User Stories / Use Cases

1. As a sales user directly assigned `Initial contact`, I can open My Tasks, a notification, or the related deal and complete it without workflow administration access.
2. As a member of a candidate role, I can see an unclaimed `Initial contact`, claim it, and then complete it.
3. As another member of the same role, I no longer see or mutate the task after a colleague claims it.
4. As an unrelated user, I cannot infer, open, claim, or complete the task by guessing its UUID.
5. As an administrator, I can still inspect workflow definitions and instances, while task execution follows the same assignment contract.
6. As an eligible task performer viewing the related deal, I see company/person/deal context supplied by the host deal page and a direct task CTA. Deal ownership alone never grants task access.
7. As an operator, completing the task resumes the paused instance exactly once and advances it to the next step.

## Architecture

### Server-side boundary

- Introduce a workflows task-access helper/service that builds the personal performer predicate from `tenantId`, effective `organizationId`, `userId`, role names, active status, and claim state.
- Personal list/detail use the same predicate. `myTasks=true` is mandatory for the operational inbox and deal widget. A separate manager check gates broad list/detail inspection.
- Claim and complete run their final status/ownership check and mutation in a transaction with a row lock or equivalent conditional update.
- Existing task lifecycle events remain; a declared application event `workflows.task.assigned` is emitted only after task persistence succeeds.
- Task serialization enriches responses with optional `sourceEntityType` and `sourceEntityId` from the scoped workflow instance.
- Event-triggered instances fall back to the event namespace/entity pair (for example `customers.deal`) when neither the payload nor trigger config provides an entity type, so host discovery is deterministic.
- Task list accepts additive `entityType` and `entityId` filters for host widgets.

### Module boundary

```text
customers deal detail
      │ existing InjectionSpot + deal context
      ▼
workflows deal-task widget ── GET/POST workflows task APIs
      │
      └── no customers import, no direct ORM relation

USER_TASK handler ── workflows.task.assigned ── notification subscriber
```

The workflows module may inject into the existing `detail:customers.deal:status-badges` spot. If `customers` is disabled, the widget has no host and no runtime failure. If no eligible task exists, the widget renders nothing.

### Commands & Events

| Contract | Change |
|---|---|
| `workflows.task.assigned` | Declare as an application event with task ID, task name, workflow instance ID, tenant/org IDs, and optional direct assignee ID. |
| `handleUserTaskStep` | Emit after the task is durably created. Do not emit on rolled-back creation. |
| claim task | Preserve existing lifecycle event; only emit for the winning claimant. |
| complete task | Preserve existing lifecycle event and resume logic; only the winning completion resumes the workflow. |
| notification type | Preserve `workflows.task_assigned`; deep link becomes `/backend/tasks/{taskId}`. |

## Data Models

No schema migration is required.

### UserTask

Existing fields remain authoritative:

- `tenantId`, `organizationId`: hard scope boundary;
- `assignedTo`: direct user ID;
- `assignedToRoles`: candidate role names;
- `claimedBy`, `claimedAt`: exclusive role-queue owner;
- `status`: `PENDING`, `IN_PROGRESS`, `COMPLETED`, or `CANCELLED`;
- `completedBy`, `completedAt`: completion audit.

The implementation does not repurpose `assignedToRoles` as user IDs and does not add a cross-module foreign key.

State invariants:

- direct assignment: `assignedTo != null`, `assignedToRoles = null`, initial status `PENDING`, direct actor may complete from `PENDING` or `IN_PROGRESS`;
- role queue: `assignedTo = null`, non-empty `assignedToRoles`, initial status `PENDING`; claim changes it to `IN_PROGRESS` and sets `claimedBy/claimedAt` atomically;
- terminal tasks: `COMPLETED` and `CANCELLED` cannot be claimed or completed;
- claim locks the scoped row by ID first, then classifies a changed active state as `409`; scope/role mismatch remains `404`.

### Task source context

`sourceEntityType` and `sourceEntityId` are additive response fields derived from `WorkflowInstance.metadata`, not persisted duplicates. Missing or legacy metadata yields `null` and the generic task UI continues to work.

## API Contracts

### List user tasks

`GET /api/workflows/tasks`

Additive query parameters:

- `status=PENDING,IN_PROGRESS`: existing comma-separated status filter used to request active work;
- `myTasks=true`: restrict to the actor eligibility predicate;
- `entityType=<entity-type>`: restrict through scoped workflow instance metadata;
- `entityId=<entity-id>`: restrict through scoped workflow instance metadata.
- `order=oldest`: additive ordering mode that applies `createdAt ASC` before pagination.

`entityType` and `entityId` must be supplied together and use AND semantics. A partial pair returns `400`. The source filter is applied against scoped workflow instances before task pagination and count; missing/legacy metadata does not match.

Operational UI always sends `myTasks=true`. Existing administrative calls without the parameter retain broad behavior only for actors with `workflows.manage`; other actors receive `403`. A manager explicitly selecting `All tasks` is the only UI path that omits personal mode.

Additive response fields per task:

```json
{
  "sourceEntityType": "customers.deal",
  "sourceEntityId": "<deal-id>"
}
```

### Get user task

`GET /api/workflows/tasks/{id}`

- Requires `workflows.tasks.view`.
- Returns `404` if tenant, organization, or personal actor eligibility fails, unless the actor has `workflows.manage` for scoped read-only inspection.
- Includes the optional source fields.

### Claim user task

`POST /api/workflows/tasks/{id}/claim`

- Requires `workflows.tasks.claim`.
- Actor must be a candidate for an unclaimed role-queue task in scope.
- The scoped task row is locked before checking status. Returns `404` for out-of-scope/role-ineligible task and `409` if an otherwise eligible task was claimed or completed concurrently.
- Returns the claimed task after commit.

### Complete user task

`POST /api/workflows/tasks/{id}/complete`

- Requires `workflows.tasks.complete`.
- Direct assignee or current claimant only.
- Keeps existing form-data validation.
- Returns `404` for out-of-scope/ineligible task and `409` for stale/duplicate completion.
- Resumes the workflow exactly once after successful completion.

## Internationalization (i18n)

All new strings use workflows translation keys with English and Polish values where EPC supports Polish:

- navigation: `workflows.tasks.myTasksNav`;
- deal widget: waiting, claim, complete, claimed, action failure;
- source context labels and `Open deal`;
- conflict/stale-task feedback.

No user-facing string or status color is hard-coded. Existing status translations are reused.

## UI/UX

### My Tasks

- Add a top-level injected navigation item `My tasks` linking to `/backend/tasks`, feature-gated by `workflows.tasks.view`.
- The list starts in personal mode and sends `myTasks=true` on every initial/filter/pagination request unless the user explicitly chooses the administrator-only all-tasks view.
- Show total results from the API. Use the existing task table, semantic status components, loading/error/empty states, and existing row actions.
- A user without broad task administration does not see an `All tasks` escape hatch.
- Manager personal mode stays personal; switching to `All tasks` issues the manager-only broad request.

### Notification

- Direct assignee receives an in-app notification after task creation.
- Clicking it opens `/backend/tasks/{id}`.
- The notification is not sent to unrelated role members or organizations.

### Deal widget

- Placement: existing `detail:customers.deal:status-badges` injection spot.
- Hidden when there is no active eligible task for the deal.
- Requests `status=PENDING,IN_PROGRESS` and shows one compact semantic callout for the earliest `createdAt` active task; no completed/cancelled task can occupy the widget.
- Uses server-side `order=oldest&limit=1`, so the selected task is globally earliest before pagination rather than merely earliest on a client page.
- Direct assignment/current claimant CTA: `Complete Initial contact`.
- Unclaimed role candidate CTA: `Claim task`; after success it changes to `Complete Initial contact`.
- If the task form schema contains required input, the primary CTA is `Open task` instead of immediate completion.
- A secondary link opens the task detail when useful.
- Successful completion invalidates task queries; the widget disappears and the workflow continues.

### Frontend architecture contract

| Surface | Server/client boundary | Data source | State owner |
|---|---|---|---|
| `/backend/tasks` | existing client page retained | guarded task list API | React Query + URL/filter state |
| task detail | existing client page retained | guarded detail/action APIs | React Query / guarded mutation |
| deal task widget | new small `widget.client.tsx` only | `myTasks=true&status=PENDING,IN_PROGRESS&entityType=customers.deal&entityId=…&order=oldest&limit=1` | local React Query cache |
| navigation entry | static data widget | no fetch | injection registry |

`"use client"` ledger:

- existing task list/detail pages remain client islands because they own filters, actions, and query cache;
- the new deal widget is client-side because it fetches actor-specific data and performs mutations;
- no provider, bootstrap, or global shell becomes client-side;
- no server-only workflow or ORM import enters client code.

Budgets and guardrails:

- new widget target: below 220 lines, no client blob above 300 lines;
- reuse `apiCall`, React Query, `useGuardedMutation`, semantic `Alert`/`StatusBadge`/`Button`, and existing injection primitives;
- no raw `fetch`, inline SVG, hard-coded status colors, dynamic imports, or new frontend dependency;
- verify desktop and narrow viewport in headed QA.

## Migration & Compatibility

- No database migration.
- Keep frozen ACL IDs, routes, event IDs, entity fields, and notification type ID.
- Preserve `workflows.view_tasks` as the page-level compatibility feature. Make `workflows.tasks.view` depend on `workflows.view_tasks`, so any role that sees the injected navigation item can open the page; make operational defaults receive the current view/claim/complete features.
- Keep `workflows.tasks.view/claim/complete` explicit. Do not make `workflows.view_tasks` imply mutation rights.
- Existing tenant roles require the standard ACL synchronization command after deployment.
- Existing administrative list calls without `myTasks=true` keep broad organization-scoped behavior.
- Existing tasks without workflow source metadata show the generic UUID/context fallback.
- The customer deal integration is optional and degrades to no widget when the host module is absent.

## Implementation Plan

### Phase 1: Secure operational task contract

1. Add centralized scoped eligibility helpers and serializers.
2. Apply them to list, detail, claim, and complete.
3. Make claim/completion concurrency-safe and preserve exactly-once resume side effects.
4. Bridge ACL defaults/dependencies without deleting legacy IDs.
5. Fix the real `myTasks=true` request and restrict all-tasks selection to managers.

### Phase 2: Discoverability and context

1. Declare and emit the assignment event for direct assignees.
2. Fix notification links and subscriber tests.
3. Add source filters/fields to task list/detail.
4. Add the injected top-level My Tasks item.
5. Add the compact deal task widget and localized text.

### Phase 3: Integration coverage and private delivery

1. Add self-contained API/integration fixtures for at least two users and two roles.
2. Prove role claim ownership, direct completion, unrelated user denial, scope denial, notification link, and exactly-once workflow resume.
3. Run focused unit/integration/type/build and DS delta checks.
4. Commit and push the private EPC branch.
5. Deploy the exact revision to preview EPC and run ACL sync.
6. Run headed desktop and narrow QA as an operational user and admin.
7. Attach screenshots and exact revision evidence to THOM-67, read it back, and obtain independent release-evidence review.
8. Close THOM-67 only after deployed QA passes; then create a separate linked upstream-contribution issue.

### File manifest

Expected areas (exact files may be consolidated during implementation):

- `packages/core/src/modules/workflows/lib/task-access.ts`
- `packages/core/src/modules/workflows/lib/task-handler.ts`
- `packages/core/src/modules/workflows/lib/step-handler.ts`
- `packages/core/src/modules/workflows/api/tasks/**`
- `packages/core/src/modules/workflows/events.ts`
- `packages/core/src/modules/workflows/notifications.ts`
- `packages/core/src/modules/workflows/subscribers/task-assigned-notification.ts`
- `packages/core/src/modules/workflows/acl.ts`
- `packages/core/src/modules/workflows/setup.ts`
- `packages/core/src/modules/workflows/backend/tasks/**`
- `packages/core/src/modules/workflows/widgets/injection/**`
- `packages/core/src/modules/workflows/widgets/injection-table.ts`
- `packages/core/src/modules/workflows/i18n/{en,pl}.json`
- focused unit and integration tests under the workflows module.

### Integration coverage matrix

| Path | Scenario | Expected proof |
|---|---|---|
| `GET /api/workflows/tasks?myTasks=true` | direct, candidate, claimed-by-other, unrelated, completed | only active direct/candidate/own-claimed tasks returned in personal active queries |
| `GET /api/workflows/tasks` | manager vs non-manager omission | manager broad list succeeds; non-manager receives `403` |
| `GET /api/workflows/tasks/{id}` | unrelated/cross-org/cross-tenant | `404`, no metadata leak |
| `POST …/claim` | two candidate users race | one success, one `409`; only winner sees task |
| `POST …/complete` | direct assignee | task completes and workflow resumes once |
| `POST …/complete` | role candidate before claim / wrong claimant | denied without mutation |
| task creation | direct assignment | notification created only for a scoped valid assignee with exact valid link |
| task creation | role queue / invalid assignee | no notification and no unrelated/cross-org recipient metadata leak |
| task list source filter | paired deal entity metadata | filter precedes count/pagination; cross-scope and partial-pair cases do not leak |
| deal widget desktop/narrow | claim then complete fieldless task | CTA transitions and disappears after workflow advances |
| deal widget desktop/narrow | form-required task | CTA opens task detail form; no invalid direct completion request |
| navigation/inbox | operational user | My Tasks visible without definition/instance admin access |

## Risks & Impact Review

### Data integrity failures

- Duplicate claims or completions could produce two owners or resume the workflow twice. Mitigation: transactional row lock/conditional mutation and regression tests.
- Existing test fixtures use role names as direct user IDs. Mitigation: update fixtures to explicit `assignedToRoles` or actual user UUIDs.

### Cascading failures & side effects

- Emitting before commit could create a notification for a rolled-back task. Mitigation: emit only after durable task persistence through the existing event boundary.
- A completion error after marking a task complete could strand the instance. Mitigation: keep task completion and instance transition in the existing transaction and test rollback behavior.

### Tenant & data isolation risks

- UUID-based detail/action access can disclose or mutate another tenant or organization. Mitigation: central scope predicate, `404`, and negative integration coverage.
- Tenant-wide role notification fan-out can leak task context across organizations. Mitigation: direct-assignee-only notification in the EPC release.

### Migration & deployment risks

- Existing operational roles will not receive new defaults until ACL synchronization. Mitigation: run and record the standard sync after deploy.
- Compatibility bridge may unintentionally broaden execution rights. Mitigation: bridge read IDs only; keep claim/complete explicit.

### Operational risks

- A static injected menu badge would become stale or misleading. Mitigation: no fake badge; use live list total and notification count until a generic dynamic menu-data contract is designed upstream.
- Deal workflows with missing source metadata will not show the widget. Mitigation: generic inbox/detail remain functional and event trigger metadata is validated in integration tests.

### Risk register

#### Cross-scope task mutation

- Severity: Critical
- Likelihood: Medium in current code, Low after change
- Detection: negative API integration tests and headed user-role QA
- Mitigation: shared server-side scope/eligibility policy
- Rollback: redeploy previous exact EPC revision; no data migration to reverse

#### Duplicate workflow resume

- Severity: High
- Likelihood: Low to Medium under concurrent action
- Detection: concurrent claim/complete test and workflow event count assertion
- Mitigation: atomic mutation and exactly-once side effects
- Rollback: redeploy; inspect affected task/instance audit events

#### ACL synchronization omission

- Severity: Medium
- Likelihood: Medium
- Detection: operational test user lacks My Tasks after deployment
- Mitigation: deployment checklist includes ACL sync and headed employee-profile proof
- Rollback: restore role grants or previous revision

#### Optional host integration regression

- Severity: Medium
- Likelihood: Low
- Detection: module-decoupling test and page QA
- Mitigation: injection-only integration with hidden empty state
- Rollback: remove/disable widget registration

## Final Compliance Report — 2026-07-10

### AGENTS.md files reviewed

- root `AGENTS.md`
- `packages/core/AGENTS.md`
- `packages/core/src/modules/workflows/AGENTS.md`
- `packages/core/src/modules/customers/AGENTS.md`
- `packages/ui/AGENTS.md`
- `packages/events/AGENTS.md`
- `.ai/qa/AGENTS.md`
- `BACKWARD_COMPATIBILITY.md`

### Compliance matrix

| Requirement | Status | Evidence in spec |
|---|---|---|
| Preserve public contracts | Compliant | additive API fields/filters; frozen IDs and routes retained |
| Tenant/organization scoping | Compliant | centralized policy and negative tests |
| Cross-module decoupling | Compliant | source metadata + widget injection, no direct ORM |
| ACL wildcard/runtime helpers | Compliant by design | existing feature guards retained; read bridge does not bypass mutations |
| Events/notifications | Compliant by design | declared event and post-persistence emission |
| UI data helpers/design system | Compliant by design | `apiCall`, React Query, guarded mutations, semantic components |
| i18n | Compliant by design | workflows translation keys; no hard-coded user copy |
| Integration tests | Compliant by plan | API and key desktop/narrow UI paths enumerated |
| Backward compatibility | Compliant | no removals, migration, or behavior change for admin list calls |
| EPC-first contribution policy | Compliant | private deploy/QA precedes separate public issue |

### Internal consistency check

- One ownership table is used by list, detail, claim, complete, UI, and tests.
- Role candidates must claim before completing; direct assignees do not.
- `myTasks=true` is the operational contract; broad admin listing remains opt-in and feature-gated.
- Notification scope is deliberately narrower than task candidacy in phase one to avoid organization leakage.
- The deal widget uses the same APIs and cannot bypass ownership rules.

### Non-compliant items

None identified in the proposed design. Implementation evidence and exact commands are pending execution.

### Verdict

Ready for EPC implementation. Security and concurrency behavior are mandatory release gates, not follow-up work.

## Changelog

### 2026-07-10

- Expanded the approved UX brief into an EPC-first implementation specification.
- Added server-side ownership semantics, concurrency requirements, API/UI contracts, compatibility policy, integration matrix, and deployment/QA gates.
- Documented why a fake static navigation badge is excluded from EPC and routed to the later generic menu-data contribution.
