# Correlated Workflow Signal Waits

## TLDR

Extend the existing `WAIT_FOR_SIGNAL` step with additive, persisted correlation so a workflow can pause for a domain event concerning the exact record created earlier in the same execution. The first scoped event that matches the routing data and a valid outgoing transition resumes the root token or parallel branch atomically; duplicates are idempotent, while routing matches rejected by transition conditions leave the wait active.

The MVP reuses `StepInstance`, the persistent event bus, existing transition conditions, and the current workflow executor. It does not add a new wait step type, polling retries, a separate condition DSL, early-event replay, or new timeout semantics.

## Overview

A transition activity can create an external or cross-module record through `CALL_API`, but the workflow cannot currently persist a subscription to a later domain event for that newly created record. Existing instance-level `correlationKey` is fixed at workflow start and cannot represent a correlation key produced mid-run.

This feature adds a stable activity-result namespace, resolves the wait correlation when the step is entered, persists the resolved subscription on the active `StepInstance`, and routes persistent domain events through an idempotent workflows subscriber.

## Problem Statement

The current `WAIT_FOR_SIGNAL` pauses an instance or branch by signal name only. Signal handling completes the active step before confirming an outgoing transition, and a rejected condition can leave the workflow running on the same wait step. The persistent event worker already forwards trusted event name, tenant, and organization metadata to wildcard subscribers, but customer lifecycle emits do not currently populate that trusted scope in event options.

The engine therefore cannot safely express: create a customer interaction task, wait for that exact task to be completed, then continue exactly once.

## Proposed Solution

- Add optional `signalConfig.correlation.contextPath` and `payloadPath` fields.
- Preserve legacy activity output keys and additionally store outputs at `activities.<activityId>`.
- Persist resolved signal routing fields on the active `StepInstance` with a scoped lookup index.
- Add a persistent wildcard workflows subscriber that resolves matching active waits from trusted event metadata.
- Evaluate outgoing transitions against a namespaced candidate signal payload before consuming the wait.
- Consume and resume under a transaction and pessimistic locks, including parallel-branch targeting.
- Preserve existing uncorrelated manual signal APIs and current timeout behavior.

## Goals / Non-Goals

### Goals

- Let a workflow activity create a record and let a later `WAIT_FOR_SIGNAL` subscribe to an event for that exact record.
- Resolve the expected correlation value from the effective token context when the wait step is entered.
- Deliver persistent events to matching root or parallel-branch waits with tenant and organization isolation.
- Evaluate outgoing transition conditions with the candidate signal payload before consuming the wait.
- Make repeated delivery of the same persistent event safe and idempotent.
- Preserve current definitions and manual signal clients that do not use correlation.
- Expose correlation configuration in both workflow node-editing paths.

### Non-Goals

- A new workflow step type or a second workflow runtime.
- Polling a remote API with retry policy while a workflow is paused.
- Replacing the existing transition condition and pre-condition mechanisms.
- Replaying domain events emitted before the wait subscription was persisted.
- Implementing or changing timeout/deadline enforcement for `WAIT_FOR_SIGNAL`.
- Changing the instance-level `correlationKey` start/resume APIs.
- Adding direct ORM relationships between workflows and customers.

## Resolved Design Decisions

1. **Keep `WAIT_FOR_SIGNAL`.** Correlation is optional configuration on the existing step. A separate `WAIT_FOR_PROPERTY`, `WAIT_FOR_TASK`, or CRM-specific step would duplicate pause/resume behavior and couple workflows to another module.
2. **Use domain events, not polling.** The customer interaction completion event already exists and persistent delivery provides the correct reliability boundary. Retry policy remains an activity execution concern, not a waiting mechanism.
3. **Persist a resolved subscription on `StepInstance`.** One active wait maps to one active step instance, so a separate subscription entity would add lifecycle and consistency work without a current need.
4. **Use trusted subscriber context for scope.** `tenantId`, `organizationId`, and `eventName` come only from persistent event metadata. Matching never trusts similarly named payload fields.
5. **Deliver to every exact scoped match.** Separate workflow instances may intentionally wait for the same event, path, and correlation value. Each matched active step is processed independently and exactly once.
6. **Keep early events out of scope.** The guaranteed sequence is activity result committed to context, wait subscription persisted, then matching event received.
7. **Keep timeout behavior unchanged.** The existing timeout remains definition metadata parsed and logged by the step handler; this feature does not introduce a scheduler or deadline field.

## Definition Contract

Correlation is an additive optional object:

```ts
signalConfig: {
  signalName: 'customers.interaction.completed',
  timeout?: 'PT5M',
  correlation?: {
    contextPath: 'activities.create_customer_task.body.id',
    payloadPath: 'id',
  },
}
```

- `contextPath` reads the expected value from the effective token context when `WAIT_FOR_SIGNAL` is entered.
- `payloadPath` reads the observed value from the later event payload.
- Both fields are required when `correlation` is present. Neither may be configured alone.
- Paths use dot-separated object keys. Each segment accepts letters, digits, `_`, and `-`; empty segments, array indexes, wildcards, and prototype keys are rejected.
- The resolved values must be non-empty scalar strings, numbers, or booleans. Values are normalized with `String(value)` before comparison. Objects, arrays, `null`, `undefined`, and empty strings fail wait entry with a clear step execution error.
- A definition without `correlation` retains the legacy manual-signal behavior and is not auto-resumed by the domain-event subscriber.

The customer-task use case is configured as:

```text
CALL_API activity create_customer_task
  -> result at activities.create_customer_task.body.id
WAIT_FOR_SIGNAL customers.interaction.completed
  -> expected value from activities.create_customer_task.body.id
  -> observed value from event payload id
```

## Activity Output Contract

Every successful activity result is additionally written below a stable activity-ID namespace:

```ts
context.activities[activityId] = output
```

This applies to synchronous transition activities, synchronous step activities, and completed asynchronous activities. Existing observable keys remain unchanged:

- synchronous outputs still remain under `activityName || activityType`;
- asynchronous outputs still remain under `${activityId}_result`;
- existing context values outside `activities` are not renamed or removed.

Merging a new output preserves other entries already present under `context.activities`.

## Data Model

Add nullable routing columns to `step_instances`:

| Property | Column | Type | Meaning |
|---|---|---|---|
| `waitSignalName` | `wait_signal_name` | varchar(255), nullable | Trusted event name expected by this active wait |
| `waitCorrelationKey` | `wait_correlation_key` | varchar(255), nullable | Expected scalar resolved from token context |
| `waitPayloadPath` | `wait_payload_path` | varchar(500), nullable | Definition path used to extract the event value |

Add a composite lookup index covering tenant, organization, active status, signal name, and correlation key. Existing rows receive `NULL` for all three fields. The fields are set only for correlated `WAIT_FOR_SIGNAL` steps and cease to be routable when the step status leaves `ACTIVE`; no cleanup mutation is required for historical step records.

The definition keeps the declarative paths. The active `StepInstance` keeps only the resolved routing data needed to deliver and audit that particular wait.

## Runtime Architecture

### Registering the wait

When a root or branch token enters `WAIT_FOR_SIGNAL`:

1. Resolve the configured `contextPath` against the token's effective context (`instance.context` for root, token read context for a branch).
2. Validate and normalize the resolved scalar.
3. Persist `waitSignalName`, `waitCorrelationKey`, and `waitPayloadPath` on the already-created active `StepInstance` in the same transaction as the paused token state.
4. Log `SIGNAL_AWAITING` with routing metadata but not the full source context.
5. Mark the root `PAUSED` or branch `PAUSED`, retaining current behavior.

If correlation is absent, the three columns remain `NULL` and the wait is reachable through the existing manual signal API only.

### Routing a persistent event

Add a focused persistent wildcard subscriber under the workflows module. It is separate from the existing event-trigger subscriber because starting a workflow and resuming an active wait are different side effects.

The subscriber:

1. Rejects delivery when trusted `eventName`, `tenantId`, or `organizationId` is missing.
2. Rejects events carrying the platform-owned `_workflow.workflowInstanceId` provenance added by user-authored `EMIT_EVENT` activities. Such events remain available for ordinary workflow choreography but cannot impersonate an authoritative domain mutation and consume a correlated wait.
3. Reads only the distinct configured payload paths for active subscriptions scoped by trusted tenant, organization, and signal name.
4. Resolves each distinct path once, then queries exact candidates by scope, signal name, payload path, and normalized correlation key so the composite routing index can narrow the working set.
5. Calls the signal delivery service for every exact match. A match in one workflow never suppresses another legitimate match.

The subscriber does not import customer code and does not interpret customer-specific fields. `customers.interaction.completed` is simply the first concrete event using the generic contract.

### Atomic candidate delivery

Each exact candidate is consumed in a transaction:

1. Lock the `StepInstance` pessimistically and re-check `ACTIVE`, scope, signal name, payload path, and correlation key.
2. Lock its `WorkflowInstance`; for a branch wait, also lock the exact `WorkflowBranchInstance` and verify it remains `PAUSED` on the same step.
3. Build candidate signal context at:

   ```ts
   signals[stepId] = {
     name: eventName,
     payload,
     receivedAt,
   }
   ```

4. Evaluate only outgoing `trigger: 'auto'` transitions, including inline conditions and pre-conditions, using the candidate token context.
5. If no transition is valid, log `SIGNAL_IGNORED` with a reason and leave the step and token paused. Do not persist the candidate signal payload.
6. If a transition is valid, merge the namespaced signal context into the root or branch namespace, mark the token resumable, exit the active step, log `SIGNAL_RECEIVED`, and execute the selected transition for the exact execution token. Here, executing the selected transition includes its conditions and activities, advancing the token cursor, and entering the destination step through `executeTransitionForToken`.
7. If that in-transaction transition reports failure, throw so the transaction rolls back the signal context, wait exit, cursor change, and destination-step effects.
8. Commit only after the selected transition and destination-step entry succeed. Then invoke the normal workflow executor to continue any later automatic transitions. A failure in this post-commit continuation does not resurrect the legitimately consumed wait; it marks the parent instance `FAILED` with a recovery marker while retaining the root or branch cursor at the durable destination. The existing retry endpoint restores `RUNNING` for a root token or `FORKED` for a branch token and continues from that cursor.

The pre-lock discovery query is only a candidate list. The locked re-check is the idempotency boundary: a redelivered event or concurrent handler finds that the step is no longer active and becomes a no-op.

### Manual signal compatibility

The existing instance-ID and instance-correlation APIs remain supported with their current request and response contracts. Their consume order is corrected to use the same invariant: build candidate context, evaluate a valid automatic transition, then exit the active wait and resume. This intentionally corrects one invalid legacy behavior: a condition rejection now keeps the root or branch paused instead of leaving it running on an already exited wait.

Legacy manual payload aliases and flat payload merge remain available to existing definitions. The new `signals.<stepId>` namespace is added for correlated event delivery and may also be populated by the refactored manual path without removing old keys.

## Customer Event Scope

`customers.interaction.completed` already carries the interaction `id` required by `payloadPath: 'id'`. Update the customer lifecycle emitter to pass trusted `tenantId` and `organizationId` in event options together with `persistent: true`. Completion-event enqueue errors are no longer swallowed. A hidden nullable `CustomerInteraction.completionEventEmittedAt` delivery marker is checked under a pessimistic row lock: the durable event is enqueued once, then the marker is persisted in the same database transaction. If enqueue fails, the marker remains `NULL`, so retrying completion republishes without repeating the domain mutation; after success, repeated completion calls are no-ops for event delivery.

Every lifecycle-event call site must supply scope from command arguments or persisted entity state. The event payload remains a domain contract, but its tenant and organization properties are not authorization or routing inputs.

No existing event ID or payload field is changed.

## UI/UX and Internationalization

Both current node-editing implementations must expose the same optional fields for `WAIT_FOR_SIGNAL`:

- **Correlation context path** — example `activities.create_customer_task.body.id`;
- **Event payload path** — example `id`.

Saving either field requires the other. Emptying both removes `signalConfig.correlation`. Reopening a saved workflow must restore both values. The editor continues to expose signal name and timeout unchanged.

Labels, help text, validation messages, and examples use workflow translation keys in all existing workflow locales (`en`, `de`, `es`, `pl`). No user-facing strings introduced by this feature are hard-coded.

## API Contracts

No new HTTP route is required.

- Workflow definition create/update/read endpoints accept and return the additive `signalConfig.correlation` object through the existing definition schema.
- Existing `POST /api/workflows/instances/:id/signal` behavior and authorization remain compatible.
- Existing instance-correlation signal endpoint remains unchanged.
- Existing `POST /api/customers/interactions/complete` emits the already-declared persistent completion event with trusted scope options after successful completion.

## Migration & Backward Compatibility

### Database migration

- Generate a workflows module migration for the three nullable columns and composite index.
- Generate a customers module migration for the hidden nullable completion-event delivery marker.
- Update the workflows MikroORM snapshot through the repository generator; do not hand-edit generated registry files.
- Do not run the migration against a local or shared database as part of implementation without explicit approval.

### Compatibility surfaces

- **Database:** additive nullable columns in workflows and customers; no backfill and no rewrite of existing rows. Existing completed interactions publish at most once when the completion command is next retried.
- **Definition JSON/schema:** optional nested fields; definitions without correlation validate and execute unchanged.
- **Workflow status/state:** one intentional bug fix changes behavior—rejected candidates remain paused and active instead of producing an inconsistent running token with an exited wait.
- **Manual signal API:** route, request shape, success status, scoping, and instance-correlation fan-out remain supported.
- **Activity context:** new nested aliases are additive; legacy sync and async keys remain present. If the legacy alias itself is named `activities`, object output is merged with the stable namespace; a scalar legacy value remains scalar and the stable alias is omitted for that conflicting batch because both contracts cannot occupy the same JSON path.
- **Events:** no event ID or payload removal; customer emit options gain trusted scope metadata.
- **Parallel execution:** only the exact matched branch token resumes; siblings and join accounting are unchanged.
- **Timeout:** current semantics are unchanged.
- **UI:** old definitions load with blank correlation fields and save without a correlation object unless configured.
- **RBAC:** no feature IDs, wildcard behavior, or authorization requirements change.
- **Encryption and tenant isolation:** existing encrypted/scoped entity helpers remain in use; every lookup includes tenant and organization.
- **Module decoupling:** workflows consumes the event generically; neither module creates a direct ORM or source dependency on the other.
- **Generated registries/build exports:** regenerate subscribers after adding the file; no public package export is required unless a real test or call site needs it.

## Implementation Plan

### Phase 1 — contracts and failing tests

- Extend validators and node form transformations with the correlation pair.
- Add focused tests for schema validation, editor round-trip, path resolution, and additive activity output aliases.
- Add failing signal tests for condition-first consumption, trusted scope, exact root/branch routing, and duplicate delivery.

### Phase 2 — persistence and wait registration

- Add the `StepInstance` routing fields, composite index, migration, and snapshot.
- Resolve and persist correlation in the wait step handler for root and branch tokens.
- Keep uncorrelated waits on the legacy path.

### Phase 3 — event routing and atomic consume

- Add the persistent wildcard workflows subscriber and generic correlated delivery function.
- Lock and re-check step, instance, and branch state; evaluate conditions before exit; resume through execution tokens.
- Correct the legacy manual consume order without changing its API.
- Forward trusted scope from customer lifecycle event emission.
- Run `corepack yarn generate` for subscriber discovery.

### Phase 4 — activity outputs and editor

- Add `activities.<activityId>` for sync and async completion paths while preserving legacy aliases.
- Add the two correlation inputs and pair validation to both node-edit dialog paths.
- Add and verify workflow translations for all existing locales.

### Phase 5 — integration and delivery gates

- Add self-contained API integration coverage for definition round-trip and the customer-task flow.
- Run focused unit/integration checks, build/typecheck as required by touched surfaces, and one fresh primary review.
- Deploy the private EPC branch to `preview-epc.om.they.dev` through the existing runbook.
- Run headed `agent-browser` QA, attach durable evidence to the Jira source task, read it back, and obtain an independent release-evidence review.

## Integration & Test Coverage

### Unit and module tests

- Validator accepts a complete correlation pair and rejects partial, empty, unsafe, or non-string paths.
- Node form transforms round-trip both paths and remove correlation when both are cleared.
- Wait entry persists the resolved value for root and branch contexts.
- Missing, empty, or non-scalar context values fail the wait step instead of creating a broad subscription.
- Stable activity output is written for transition activities, step activities, and async completion while legacy keys remain.
- Subscriber ignores missing trusted scope, wrong event name, wrong tenant/org, wrong payload path/value, and inactive steps.
- A matching root event resumes only the exact wait.
- A matching branch event resumes only the exact branch and preserves sibling state.
- A false outgoing condition logs an ignored candidate and keeps the wait active/paused.
- Duplicate or concurrent delivery does not execute the transition twice.
- A selected-transition failure inside delivery rolls back signal context, wait exit, cursor movement, and destination-step effects.
- A later automatic-continuation failure after commit leaves the token durably at the entered destination step and recoverable by the existing execution path.
- A workflow-authored `EMIT_EVENT` carrying `_workflow` provenance cannot consume a correlated domain wait.
- Completion-event enqueue failure is surfaced; an idempotent repeat re-enqueues only while the locked delivery marker remains empty, and successful delivery prevents further replay.
- Existing manual root and branch signal behavior remains valid; false conditions now preserve the wait.
- Customer completion emission passes trusted tenant and organization event options.

### API integration tests

`TC-WF-032` — correlated customer-task wait:

1. Create all company and workflow fixtures through APIs; do not rely on seeded data.
2. Configure a transition `CALL_API` activity with ID `create_customer_task` to create a customer-related task.
3. Enter a correlated `WAIT_FOR_SIGNAL` for `customers.interaction.completed`, using `activities.create_customer_task.body.id` and payload `id`.
4. Create a second control task.
5. Start the workflow and poll until its exact wait is active and paused.
6. Complete the control task and verify the workflow remains paused.
7. Complete the task created by `CALL_API` and verify the workflow reaches `COMPLETED`.
8. Deliver/retry the matching event again where the public test seam permits and verify no duplicate transition/history advancement.
9. Clean up created records and workflow definition in `finally`.

`TC-WF-033` — definition correlation round-trip:

1. Create a workflow definition with both correlation paths.
2. Read it back and assert exact preservation.
3. Update both paths, read it back again, and assert the updated values.
4. Clean up in `finally`.

Both tests declare `integrationMeta.dependsOnModules = ['workflows', 'customers']` where applicable and use deterministic API polling rather than fixed sleeps.

### Headed private QA

- In the visual editor, configure and save signal name plus both correlation paths; reload and confirm persistence.
- Start a workflow that creates task A and waits for A.
- Complete unrelated task B and confirm the workflow visibly remains paused.
- Complete task A and confirm the workflow advances exactly once and the task is completed.
- Refresh workflow history/state and verify the final status persists with a single signal/transition consumption.
- Exercise a user with the intended workflow and customer permissions; verify no cross-organization task can resume the wait.

## Risks & Failure Scenarios

| Risk | Mitigation / expected behavior |
|---|---|
| Persistent event retry races with the first delivery | Pessimistic lock and active-step re-check make later delivery a no-op |
| Two branches wait for the same signal | Route by exact `StepInstance` and lock the exact branch; siblings remain untouched |
| Event payload carries spoofed tenant/org | Ignore payload scope and require trusted subscriber context |
| User-authored workflow emits a reserved-looking domain event | Reject `_workflow`-provenance events from correlated wait delivery; only the real domain command can produce the accepted completion event |
| Transition condition rejects the event | Leave wait active and token paused; log only the rejection reason/routing metadata |
| Correlation path is invalid or missing at wait entry | Fail the step clearly; never create an unscoped subscription |
| Activity output key change breaks definitions | Add `activities.<id>` while retaining every legacy alias |
| Event arrives before registration | Not replayed in MVP; document ordering requirement |
| Many waits use the same event name in one scope | Read projected distinct payload paths, resolve each once, then query exact path/key candidates through the composite routing index rather than materializing every wait |
| Selected transition fails before commit | Transaction rolls back signal context, wait consumption, token cursor, and destination-step effects |
| Later automatic continuation fails after commit | Wait remains legitimately consumed; the parent is marked failed with root/branch recovery metadata, and retry resumes from the durable destination cursor |
| Customer completion commits but durable event enqueue fails | Keep the locked delivery marker empty, surface the failure, and allow the idempotent completion command to retry; successful enqueue records the marker and blocks replay flooding |
| Customer module is disabled | No completion event is emitted; workflows remains decoupled and manual signal waits still work |

## Compliance Review

- **Scope cohesion:** one generic workflow capability plus the minimum customer event-scope fix required to exercise an existing domain event. No CRM-specific logic enters workflows.
- **Backward compatibility:** additive definition fields, nullable columns, additive context aliases, unchanged endpoints/event IDs, and explicit legacy signal tests.
- **Tenant safety:** trusted metadata only; tenant and organization included in discovery and locked re-checks.
- **Module boundaries:** persistent events are the integration boundary; no cross-module ORM relationship or direct workflows-to-customers import.
- **Reliability:** persistent subscriber, transactional consume, pessimistic locks, retry-safe no-op, and condition-before-exit invariant.
- **Observability/privacy:** awaiting/ignored/received lifecycle events contain identifiers and reasons needed for diagnosis without copying full workflow context into logs.
- **Operational impact:** one additive migration and one auto-discovered persistent subscriber; no new worker, queue, scheduler, dependency, or configuration flag.

## Open Follow-ups (Out of Scope)

- Deadline enforcement and timeout transitions for signal waits.
- Durable inbox/replay for events that predate wait registration.
- UI path pickers or expression builders instead of text paths.
- Operational metrics for correlated-wait backlog and delivery latency.

## Implementation Status

- [x] Architecture and compatibility design
- [x] Pre-implementation audit
- [x] Contract and regression tests
- [x] Runtime, migration, output namespace, and UI implementation
- [x] Focused verification and primary/security review
- [ ] Private deployment, headed QA, durable Jira evidence, and release-evidence review
- [ ] Upstream contribution gates and public implementation

## Changelog

- 2026-07-20: Initial implementation-ready specification for THOM-73.
- 2026-07-20: Corrected the baseline assessment: the persistent event worker already forwards trusted event name and scope; only customer emit options require scope propagation.
- 2026-07-20: Clarified the atomic boundary between selected-transition execution and post-commit automatic continuation; documented the intentional legacy condition-handling bug fix.
- 2026-07-20: Implemented persisted correlation, exact event routing, root/branch recovery, stable activity outputs, editor fields, migration, and self-contained integration scenarios; added provenance filtering and idempotent customer completion event re-enqueue after implementation and security review.
- 2026-07-20: Closed review findings by executing selected transitions by ID across signal/task/timer/advance paths, rolling failed post-commit continuation transactions back before recording recovery metadata, grouping routing paths in SQL, and persisting a locked completion-event delivery marker.
