# Quote Status Workflow Signals

## TLDR

Add one declared, persistent `sales.quote.status_changed` event and expose the existing declared-event combobox in both `WAIT_FOR_SIGNAL` editors. A workflow correlates the event by quote `id`, while its outgoing transition checks `signals.<stepId>.payload.status` for the target value.

This is one deployable workflow capability: the Quote event supplies the domain signal and the editor makes declared signals discoverable without removing support for custom/manual signal names.

## Overview

The correlated `WAIT_FOR_SIGNAL` runtime can already pause for one exact domain record, but Quote status transitions do not emit a dedicated lifecycle event and the editor renders the signal name as a plain text input. The runtime also evaluates inline transition conditions, but the workflow-definition validator did not preserve that already-supported field.

The design follows the message-correlation model used by workflow engines such as Camunda: event name plus business key selects the waiting execution, while payload data decides which outgoing path is valid. It deliberately reuses Open Mercato's declared-event registry, persistent event bus, correlation fields, and transition condition evaluator.

## Problem Statement

- A workflow cannot react specifically to a Quote status transition such as `sent` or `confirmed`.
- `sales.quote.updated` is not a safe substitute: an unrelated edit while a Quote already has the target status could resume a wait incorrectly.
- Users cannot discover declared event IDs while configuring a wait.
- Adding a Quote-specific wait step or using activity retry would duplicate the existing pause/resume runtime and mix routing with outcome evaluation.

## Proposed Solution

- Declare and emit `sales.quote.status_changed` only when the persisted status value changes.
- Include quote `id`, `previousStatus`, current `status`, current `statusEntryId`, tenant/organization identifiers, and optional conversion `orderId` in the payload.
- Emit through the persistent event bus with trusted tenant and organization options after the corresponding successful domain write.
- Reuse `EventPatternInput` in both workflow node editor implementations. It reads the existing authenticated `/api/events` catalog, supports search by label or ID, and preserves custom signal names.
- Preserve and validate the existing inline `transition.condition` expression so the candidate signal payload can actually gate consumption after a definition is saved.
- Keep the target-status check in the existing outgoing transition condition namespace. Do not add a status property to `WAIT_FOR_SIGNAL`, a second condition DSL, polling, or a new wait type.

## Goals and Non-Goals

### Goals

- Resume only waits correlated to the exact Quote ID.
- Leave the wait active for a non-target Quote status.
- Resume exactly once when the same Quote reaches the configured target status.
- Cover status changes made by Quote update, send, public/portal acceptance, and update undo paths.
- Make declared signals discoverable in both active workflow editor implementations.
- Preserve existing workflow definitions and custom/manual signal names.

### Non-Goals

- A new wait step, retry policy, polling worker, or expression language.
- A status-value picker in this phase; status remains an outgoing transition condition value.
- Replaying events emitted before a wait subscription exists.
- Treating Quote creation as a status change.
- Changing Quote status semantics, Quote-to-Order conversion rules, RBAC, or public API shapes.
- Solving the platform-wide domain-write/event-enqueue atomic outbox problem in this private increment.

## Design Decisions

| Decision | Rationale |
|---|---|
| Use `sales.quote.status_changed` | A dedicated lifecycle event represents an actual transition; broad CRUD updates can produce false positives. |
| Correlate on payload `id` | It matches existing Quote event identifiers and the correlated-wait contract. |
| Evaluate `payload.status` on the outgoing transition | Correlation answers *which Quote*; the transition condition answers *which status*. The runtime keeps the wait active when the condition rejects a candidate, while the definition validator now preserves the condition instead of stripping it. |
| Reuse `EventPatternInput` and `/api/events` | The platform already provides a searchable declared-event catalog and custom-value compatibility. No duplicate API or primitive is needed. |
| Emit only after successful status persistence | Consumers must not observe a transition that the Quote write later rolls back. Enqueue failure is surfaced rather than silently pretending the workflow was notified. |

## User Stories

- A workflow author wants to select a declared signal from the editor so they do not have to guess event IDs.
- A workflow author wants to wait for the exact Quote created earlier in the flow and continue only when it becomes `confirmed`.
- An existing workflow author wants a saved custom signal name to keep loading and saving unchanged.

## Architecture

### Event contract

```ts
event: 'sales.quote.status_changed'
payload: {
  id: string
  previousStatus: string | null
  status: string | null
  statusEntryId: string | null
  tenantId: string
  organizationId: string
  orderId?: string
}
options: {
  persistent: true
  tenantId: string
  organizationId: string
}
```

The event is declared in the Sales module with entity `quote` and category `lifecycle`. The payload carries scope for downstream domain use, but the workflow subscriber continues to route only from trusted event options.

### Status mutation coverage

| Write path | Transition | Emission point |
|---|---|---|
| `sales.quotes.update` | explicit status update or sent Quote reset to `draft` | after the atomic Quote write commits |
| Quote graph-restoring undo | an existing Quote is restored to a snapshot whose status differs from its current status | through one shared restore-and-emit wrapper after the restored graph is flushed |
| `POST /api/sales/quotes/send` | current status to `sent` | after send-state transaction commits and before email delivery |
| public or portal Quote acceptance | `sent` to `confirmed` plus conversion | after the acceptance/conversion transaction commits; payload includes `orderId` |

All call sites use one focused Sales emitter so event name, comparison, payload, persistence, and scope cannot drift. Every undo handler that restores a Quote graph uses one shared restore-and-emit wrapper. The wrapper captures the currently persisted status before restoration and emits only after flush when the Quote existed and the restored status differs. Undo of deletion/conversion can recreate an absent Quote; recreation is not a status transition and does not emit this event.

### Workflow configuration

```ts
signalConfig: {
  signalName: 'sales.quote.status_changed',
  correlation: {
    contextPath: 'activities.create_quote.body.id',
    payloadPath: 'id',
  },
}
```

The automatic outgoing transition evaluates the existing signal namespace:

```text
signals.<waitStepId>.payload.status equals confirmed
```

An event for another Quote fails correlation. An event for the correct Quote with a non-target status reaches condition evaluation and leaves the wait active. The first event for the correct Quote and target status consumes the wait atomically; duplicates are no-ops under the existing locked correlated-delivery path.

### Signal catalog UI

Both `NodeEditDialog` and the feature-flagged `NodeEditDialogCrudForm` render `EventPatternInput` for `signalName`.

- Focus/type opens a searchable list of declared events.
- Each suggestion displays its human label and exact event ID.
- Selecting a suggestion stores the event ID, not the label.
- A value absent from the current catalog remains visible and can be saved, preserving custom/manual signals and definitions created when a module is temporarily disabled.
- The existing signal-name label, help text, placeholder, timeout, and correlation fields remain unchanged.

## Data Models

No database schema change is required. The Quote, workflow definition, and correlated wait persistence models are unchanged.

## API Contracts

No new route is required.

- `GET /api/events` already returns declared events from enabled modules; generation adds `sales.quote.status_changed` to the registry.
- Existing Quote send, acceptance, update, and undo contracts remain unchanged.
- The workflow definition API additively accepts and preserves the inline `transition.condition` expression already supported by the runtime evaluator. Existing definitions without it remain unchanged.
- The new event ID and payload are additive public event surfaces.

## Internationalization

No new editor copy is required. Both editors reuse existing workflow signal-name translation keys. The event registry label is `Quote Status Changed`, consistent with existing declared-event labels.

## Frontend Architecture Contract

### Server/client boundary and ledger

| Surface/file | Boundary | Reason | Heavy dependency change |
|---|---|---|---|
| Workflow visual editor page | existing client editor | graph editing and dialog state | none |
| `NodeEditDialog.tsx` | existing client island | local form state | reuses existing lazy query/combobox code |
| `NodeEditDialogCrudForm.tsx` | existing client island | CrudForm-backed editor | reuses existing lazy query/combobox code |

No page root, provider, bootstrap registry, or new client file is introduced. Existing client files remain over the normal size guardrail for historical reasons, but this change replaces one text field in each and does not expand their responsibility. Verification requires focused component interaction tests, `yarn check:client-boundaries` when available, and the normal Core build.

## Migration and Backward Compatibility

- **Event IDs:** additive new ID; no existing ID is renamed or removed.
- **Event payloads:** new contract only; no existing payload narrows.
- **API:** no URL, method, response, or authorization change; the workflow-definition request validator additively preserves optional `transition.condition`.
- **Database:** no migration.
- **Workflow definitions:** existing string `signalName` shape is unchanged; optional inline conditions that were previously stripped now round-trip and use the existing Business Rules safety validation.
- **UI:** custom values remain allowed; saved values not present in the registry round-trip unchanged.
- **Generated registries:** regenerated through `corepack yarn generate`; generated files are not edited manually.
- **Module boundaries:** Sales emits a domain event; Workflows consumes it generically through the existing persistent wildcard subscriber. Neither module imports the other's business logic.

## Implementation Plan

### Phase 1 — contract and RED tests

1. Add failing Sales tests for send, acceptance, update/reset, unchanged status, and scope/payload.
2. Add failing workflow editor tests proving the Quote event is discoverable/selectable and a custom saved value still round-trips.
3. Add the declared event assertion through the real event registry/generation path.

### Phase 2 — Sales event production

1. Declare `sales.quote.status_changed` in Sales events.
2. Add the focused status-change emitter helper.
3. Wire every scoped status mutation path and update undo without changing Quote business rules.

### Phase 3 — editor catalog

1. Replace the plain signal input with `EventPatternInput` in `NodeEditDialog`.
2. Use the same component through the custom CrudForm field in `NodeEditDialogCrudForm`.
3. Preserve existing translation keys and custom values.

### Phase 3a — transition-condition persistence

1. Add a regression test proving safe inline conditions survive workflow-definition validation.
2. Reuse the Business Rules condition-expression validator instead of adding a second DSL.
3. Preserve unmanaged transition fields, including `condition`, through the CrudForm editor's Advanced Configuration round-trip.

### Phase 4 — verification and private delivery

1. Run focused tests, generation, typecheck/build, client-boundary check, and diff audit.
2. Obtain one fresh primary review plus security review for event-scope handling.
3. Deploy the exact revision to `preview-epc.om.they.dev`.
4. Run headed E2E for catalog selection and Quote status waiting, attach durable Jira evidence, read it back, and obtain release-evidence review.
5. Assess upstream applicability only after the private acceptance path passes.

## Integration and Test Coverage

### Unit/module coverage

- Declared event registry contains `sales.quote.status_changed` with the expected label/category/entity.
- Status emitter does nothing when previous and current status are equal.
- Status emitter uses persistent delivery and trusted tenant/organization options.
- Send emits `draft -> sent` with the exact Quote ID.
- Acceptance emits `sent -> confirmed` and includes the created order ID.
- Update/reset emits the stored before/after statuses; unchanged edits do not emit.
- Every Quote graph-restoring undo emits only when an existing Quote is restored to a different status; recreation of an absent Quote does not emit.
- The normal editor lists and selects `Quote Status Changed` while storing `sales.quote.status_changed`.
- The CrudForm editor uses the same catalog component.
- A pre-existing custom signal remains visible and saves unchanged.

### Self-contained integration scenario: `TC-WF-034`

1. Create a Quote fixture and a workflow definition through APIs.
2. Configure `WAIT_FOR_SIGNAL` for `sales.quote.status_changed`, correlating workflow context Quote ID to payload `id`.
3. Add an automatic outgoing condition requiring `signals.<waitStepId>.payload.status = draft`.
4. Start the workflow and wait until it is paused on the exact wait.
5. Send the target Quote so it becomes non-target `sent`; verify the workflow remains paused.
6. Edit the sent Quote so the existing domain rule restores `draft`; verify the workflow completes and stores the exact signal payload.
7. Clean up all created definitions and records in `finally`.

Exact wrong-record and duplicate-consumption behavior remains covered by the existing correlated-wait module and `TC-WF-032`; `TC-WF-034` adds the missing real Quote producer plus non-target/target condition behavior.

### Headed private QA

- Open the visual editor and verify focus/search shows declared signals with labels and IDs.
- Select `Quote Status Changed`, configure Quote-ID correlation, and save/reload the definition.
- Run the target/control Quote scenario and verify wrong Quote and wrong status do not advance.
- Confirm `confirmed` advances exactly once and persists after refresh.
- Save and reopen a custom signal value not present in the catalog.

## Risks and Impact Review

#### Domain write commits but event enqueue fails
- **Scenario**: the Quote status is committed, then the queue producer is unavailable.
- **Severity**: High
- **Affected area**: Sales-to-workflow continuation.
- **Mitigation**: persistent enqueue errors are surfaced, never swallowed; logs and the failed request expose the problem. Event emission is immediately after the committed mutation and before later external side effects where possible.
- **Residual risk**: Open Mercato has no transactionally shared outbox between module tables and the event queue. Acceptance may have committed before the enqueue error and cannot be made fully atomic in this scoped private increment. A platform outbox/recovery mechanism is a prerequisite for stronger upstream producer guarantees.

#### Wrong Quote resumes the workflow
- **Scenario**: another Quote emits the same status event.
- **Severity**: High
- **Affected area**: workflow correctness and tenant data isolation.
- **Mitigation**: correlation uses payload `id`; routing uses trusted tenant and organization event options; the existing delivery path locks and re-checks the exact active wait.
- **Residual risk**: none within the declared correlation contract.

#### Non-target status consumes the wait
- **Scenario**: the correct Quote becomes `sent` while the wait targets `confirmed`.
- **Severity**: High
- **Affected area**: workflow control flow.
- **Mitigation**: target status is an outgoing transition condition over the candidate signal payload; the existing condition-first consume invariant keeps the wait active when rejected.
- **Residual risk**: authors must configure the outgoing condition; the editor does not infer a target status.

#### Catalog hides a custom or disabled-module signal
- **Scenario**: a saved event is absent from the current enabled-module registry.
- **Severity**: Medium
- **Affected area**: definition editing.
- **Mitigation**: `EventPatternInput` allows custom values and renders the saved raw value even when it is not suggested.
- **Residual risk**: the runtime cannot deliver a domain event from a disabled source module, which is expected.

#### Event storms from unrelated Quote edits
- **Scenario**: ordinary Quote edits produce excessive events.
- **Severity**: Low
- **Affected area**: event queue and workflow subscriber.
- **Mitigation**: compare stored before/after status and emit only on an actual value change.
- **Residual risk**: bulk genuine status changes still produce one event per Quote, consistent with domain semantics.

#### Concurrent sends report a stale transition
- **Scenario**: two send requests observe `draft` and both publish `draft` to `sent`.
- **Severity**: Medium
- **Affected area**: event correctness for all subscribers.
- **Mitigation**: the send route loads and locks the Quote with `PESSIMISTIC_WRITE` inside the transaction, then captures the previous status under that lock. A concurrent regression test proves only one status event is published.
- **Residual risk**: a second serialized send can still refresh the acceptance token and email by existing route semantics, but it does not publish a false status transition.

#### Transition diagnostics disclose workflow values
- **Scenario**: an inline condition copies resolved workflow context or expected values into application logs.
- **Severity**: High
- **Affected area**: workflow data privacy and log retention.
- **Mitigation**: condition diagnostics log only field path, operator, value types, and boolean result. A regression test checks that neither resolved nor expected values appear in any log call.
- **Residual risk**: field paths remain visible for diagnostics; workflow authors should use non-sensitive structural names where practical.

## Final Compliance Report — 2026-07-21

### AGENTS.md Files Reviewed

- `AGENTS.md`
- `BACKWARD_COMPATIBILITY.md`
- `packages/core/AGENTS.md`
- `packages/core/src/modules/sales/AGENTS.md`
- `packages/core/src/modules/workflows/AGENTS.md`
- `packages/events/AGENTS.md`
- `packages/ui/AGENTS.md`
- `.ai/specs/AGENTS.md`
- `.ai/qa/AGENTS.md`

### Compliance Matrix

| Rule source | Rule | Status | Notes |
|---|---|---|---|
| root/Core | Use events for cross-module write side effects | Compliant | Sales declares/emits; Workflows remains generic. |
| Core/Events | Declare events with `createModuleEvents` and regenerate | Compliant | Additive event in existing Sales registry; run `corepack yarn generate`. |
| Events | Persistent scope must use trusted options | Compliant | Every emitter passes tenant and organization from persisted Quote state. |
| UI | Reuse existing primitives and `EventPatternInput` | Compliant | No new primitive/API or raw fetch. |
| UI | Use i18n for user-facing editor copy | Compliant | Existing workflow keys are reused. |
| Backward compatibility | Do not rename event IDs/API routes/public fields | Compliant | Additive event and optional transition-condition request field only; no existing contract is narrowed. |
| Sales | Do not change Quote-to-Order/status semantics without approval | Compliant | User explicitly requested observation of status changes; mutation semantics remain unchanged. |
| QA | Add self-contained integration coverage | Compliant | `TC-WF-034` creates and cleans its own fixtures. |
| Security | Do not disclose workflow payload values in logs | Compliant | Condition diagnostics are type-only and covered by a regression test. |
| Root simplicity | Smallest complete design, existing mechanisms first | Compliant | One event helper and two existing component substitutions. |

### Internal Consistency Check

| Check | Status | Notes |
|---|---|---|
| Data models match API contracts | Pass | No data or API model change. |
| API contracts match UI/UX | Pass | UI consumes existing `/api/events`. |
| Risks cover all writes | Pass | Update, every graph-restoring undo, send, and acceptance paths are enumerated. |
| Commands cover mutations | Pass | Existing commands/routes remain the mutation owners. |
| Cache strategy covers reads | Pass | No new read API or cache introduced. |

### Non-Compliant Items

None identified for the scoped private implementation. The lack of a platform transactional outbox is recorded as residual producer reliability risk rather than hidden or expanded into this feature.

### Verdict

**Fully compliant for private deployment: targeted verification plus fresh primary and security reviews pass; deployment, headed QA, durable Jira evidence, and release-evidence review remain.**

## Changelog

- 2026-07-21: Added the initial implementation skeleton for THOM-76.
- 2026-07-21: Finalized event sources, payload, editor reuse, compatibility, frontend boundary, integration coverage, and residual producer reliability risk.
- 2026-07-21: Expanded undo coverage to every Quote graph restoration while excluding absent-record recreation from status-change semantics.
- 2026-07-21: Added safe persistence and editor round-trip for the runtime-supported inline transition condition after `TC-WF-034` exposed that Zod previously stripped it.
- 2026-07-21: `TC-WF-034` passed against the isolated ephemeral app with no retries.
- 2026-07-21: Closed review findings for post-commit acceptance ordering, concurrent send locking, immediate custom-signal save, and condition-value log disclosure.
- 2026-07-21: Rebased onto the current `fork/EPC` baseline and isolated unrelated deterministic module-facts catch-up from the five-line THOM-76 generated delta.
- 2026-07-21: Fresh primary follow-up review closed all P1/P2 findings; security follow-up confirmed the condition-log disclosure is closed.
- 2026-07-21: Post-rebase ephemeral E2E retry was blocked before Playwright because the isolated initializer reported success without creating baseline `users`/`tenants` tables; the task-owned runtime was stopped cleanly and deployed fixed-behavior QA remains mandatory.
