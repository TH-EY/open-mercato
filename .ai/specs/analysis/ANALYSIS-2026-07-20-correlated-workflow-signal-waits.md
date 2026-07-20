# Pre-Implementation Analysis: Correlated Workflow Signal Waits

> Target spec: `.ai/specs/2026-07-20-correlated-workflow-signal-waits.md`
> Analysis date: 2026-07-20 · Scope: OSS-compatible private-first delivery · Modules: `workflows`, `customers`
> Method: full spec read, `BACKWARD_COMPATIBILITY.md` fourteen-surface audit, root/module instructions, related workflow specs, targeted code inspection, and a fresh-context scope-cohesion review.

## Executive Summary

The specification is **ready to implement**. The proposed design extends the existing `WAIT_FOR_SIGNAL` step instead of adding a second wait abstraction, uses the persistent event bus as the module boundary, persists one resolved subscription on the existing active `StepInstance`, and uses the existing execution-token and transition machinery for root and parallel-branch continuation.

The initial draft had one blocking ambiguity between in-transaction selected-transition execution and post-commit automatic continuation. The spec now states the exact boundary:

- signal context, wait exit, token cursor change, selected transition, and destination-step entry succeed or roll back together;
- only later automatic continuation runs after commit;
- post-commit continuation failure leaves the token durably at the destination step for existing recovery/retry behavior.

The current EPC baseline already passes `eventName`, `tenantId`, and `organizationId` to persistent wildcard subscribers. No `packages/events` production change is required. The minimum customer integration change is to populate trusted scope in customer lifecycle event options.

Recommendation: **GO**. Start with contract/regression tests, keep existing DI names and public entry points stable, generate the additive migration/snapshot, then implement the generic subscriber and atomic consume path.

## Scope Cohesion Review

The feature is cohesive:

1. Stable activity output makes a newly created record ID addressable.
2. Optional correlation paths define the expected and observed values.
3. `StepInstance` persists the resolved active subscription.
4. A generic persistent subscriber discovers exact scoped candidates.
5. The signal service consumes one root/branch wait transactionally and idempotently.
6. The customer change supplies trusted metadata to an existing event; it does not add customer semantics to workflows.
7. The editor and definition schema expose the same contract used by runtime.

Explicitly excluded polling, retry-as-wait, a new step type, timeout enforcement, early-event replay, and a customer/workflows ORM relationship prevent scope expansion.

Fresh-context review result: **GO** after clarifying the transaction boundary and intentional manual-signal bug fix. Its remaining suggestion—tests for in-transaction rollback and post-commit recovery—is incorporated in the spec.

## Backward Compatibility Audit

The spec contains a dedicated `Migration & Backward Compatibility` section and satisfies the deprecation-protocol requirement for contract changes.

| # | Contract surface | Assessment | Required implementation guard |
|---|---|---|---|
| 1 | Auto-discovery conventions | Additive subscriber file under the existing `subscribers/*.ts` convention | Run `corepack yarn generate`; do not edit generated registries by hand |
| 2 | Types and interfaces | Optional nested definition fields and nullable entity fields are additive | Keep `signalConfig` without `correlation` valid; retain existing activity result fields |
| 3 | Function signatures | Existing manual signal and DI-resolved service entry points are stable | Add internal helpers/functions; do not repurpose or remove existing exported arguments |
| 4 | Import paths | No existing path moves or removals required | Keep new helpers internal unless a real call site requires export |
| 5 | Event IDs | `customers.interaction.completed` is unchanged; workflow log event types are additive strings | Do not rename an existing event or payload field |
| 6 | Widget spot IDs | Unaffected | No editor injection ID changes |
| 7 | API route URLs | Existing workflow signal and customer completion routes remain unchanged | Definition JSON change is additive; preserve status/body contracts |
| 8 | Database schema | Three nullable columns and one index are additive-only | Generate migration and snapshot; no destructive SQL or backfill |
| 9 | DI service names | Existing workflow services remain stable | Reuse `signalHandler` registration or add only an additive key with a concrete call site; no rename |
| 10 | ACL feature IDs | Unaffected | Preserve current route/command permission gates |
| 11 | Notification type IDs | Unaffected | No new notification contract |
| 12 | AI agent/tool/override IDs | Unaffected | No AI registry changes |
| 13 | CLI commands | Unaffected | Use existing generators only |
| 14 | Generated file contracts | Subscriber discovery changes generated registries | Regenerate and inspect; commit only intended generated changes |

### Intentional behavior correction

The manual signal HTTP contracts remain stable, but one invalid legacy state transition intentionally changes: when no outgoing automatic transition passes, the wait remains active and the token remains paused. This is required to avoid an exited wait with a running token still pointing at the same step. Focused regression tests must distinguish compatible valid-signal behavior from the corrected invalid-condition behavior.

## Codebase Readiness

### Verified existing capabilities

- `workflowStepSchema` already models `WAIT_FOR_SIGNAL`; its `signalConfig` is the additive validation point.
- `handleWaitForSignalStep` receives the effective workflow context and the active `StepInstance`, so it can resolve and persist the subscription without another entity.
- `StepInstance` already identifies root versus branch waits and carries tenant/organization scope.
- `rootToken`, `branchToken`, `tokenReadContext`, and `executeTransitionForToken` already provide the correct root/branch execution abstraction.
- `findValidTransitions` already evaluates inline conditions and pre-conditions; results must be filtered to `trigger: 'auto'` before selection.
- `executeTransitionForToken` enters the destination step; the normal executor can continue later automatic transitions after commit.
- Persistent wildcard subscribers already receive trusted event name and scope from the events worker.
- Customer interaction completion already emits `customers.interaction.completed` with interaction `id` in the payload.
- Workflow node graph conversion preserves `signalConfig`; both node-editing paths and their shared transforms need only additive fields.

### Confirmed current defects/gaps

- Wait registration persists no signal name, correlation value, or payload path.
- Manual root signal handling exits the active step before confirming a valid transition.
- Manual parallel signal handling selects the first paused branch by signal name and resumes it without condition-first validation.
- Customer lifecycle emission sets `persistent: true` but omits trusted tenant and organization event options.
- Successful activity output is observable through unstable/legacy aliases, not consistently through `activities.<activityId>`.
- The visual editor exposes signal name and timeout only.

### Smallest implementation shape

- Keep correlation path validation/resolution as small workflow-local utilities.
- Keep correlated delivery in the existing signal service surface unless code size or circular dependencies prove a concrete need for one internal helper module.
- Add exactly one focused persistent subscriber whose only side effect is invoking the workflow signal service.
- Reuse `StepInstance`; do not introduce a subscription table, scheduler, queue, or new public endpoint.
- Update the customer lifecycle emitter once and pass explicit trusted scope at every call site.

## Data and Migration Readiness

The three proposed columns are nullable and historical. They do not require a default or backfill because only newly entered correlated waits are event-routable. Existing active uncorrelated waits remain reachable through manual signal APIs.

The composite index must begin with the fields used by discovery—tenant, organization, active status, and signal name—and may include the resolved key for exact/narrower scans. Application code must still extract the stored payload path and compare normalized values exactly; index membership is not an authorization or correctness decision.

Required migration procedure:

1. Edit the entity and relevant validators.
2. Generate the workflows migration through the repository command.
3. Inspect SQL for only three nullable columns and the intended index.
4. Inspect `.snapshot-open-mercato.json` changes.
5. Do **not** run `db:migrate` without explicit approval.

## Security and Tenant Isolation

Risk level is high enough to require explicit tests because this code consumes cross-module persistent events and resumes stateful work.

- Scope comes exclusively from subscriber context populated by the event framework.
- Missing trusted `eventName`, `tenantId`, or `organizationId` causes a no-op, not a fallback to payload scope.
- Discovery, locked re-read, instance lookup, and branch lookup all include tenant and organization.
- Correlation values route within an already trusted scope and are not secrets or authorization tokens.
- Path resolution rejects prototype keys and unsupported array/wildcard syntax.
- Logs avoid full workflow context and need not copy full event payload for rejected candidates.
- Workflow code remains generic and imports no customer entity or command.
- Customer lifecycle call sites derive scope from trusted command/entity state and place it in event options.

## Reliability and Transaction Analysis

### Idempotency boundary

Candidate discovery may race and is not authoritative. The transactional pessimistic lock of the active `StepInstance`, followed by status/scope/routing re-validation, is the consume boundary. A retry that arrives after commit finds the step non-active and returns successfully without another transition.

### Root delivery

- Lock active wait and workflow instance.
- Require root instance `PAUSED` on the same step.
- Evaluate candidate context before mutation.
- On valid transition: set root resumable, merge namespaced signal, exit step, execute selected transition, commit.

### Branch delivery

- Lock active wait, workflow instance, and the exact referenced branch.
- Require branch `PAUSED` on the same step; never scan for the first signal-name match after the candidate is selected.
- Merge only through the branch token namespace.
- Resume the matched branch without changing sibling cursor/status.

### Failure boundaries

- No valid automatic transition: log ignored, keep wait and token paused, persist no candidate payload.
- Selected-transition failure: throw and roll back the full consume/advance transaction.
- Post-commit later continuation failure: token is already durably at the destination step and follows existing workflow executor recovery semantics.
- One event may legitimately resume multiple different workflow instances; each candidate has an independent transaction so one failure does not invalidate another successful delivery.

## Test Readiness and Traceability

| Acceptance requirement | Primary automated evidence |
|---|---|
| Definition supports correlation paths | Validator unit tests + `TC-WF-033` API round-trip |
| Resolved subscription persists | Root/branch step-handler tests + migration/schema assertions |
| Exact customer task completion resumes | `TC-WF-032` self-contained API integration |
| Wrong task/event/scope does not resume | Subscriber/delivery unit tests + control task in `TC-WF-032` |
| Duplicate delivery is idempotent | Concurrent/repeated delivery unit test + history assertion where integration seam permits |
| False condition keeps wait paused | Manual and correlated signal unit tests |
| Valid manual signals remain compatible | Existing `signals.test.ts` and `TC-WF-025` unchanged/extended |
| Parallel branch targeting | Root/branch token delivery unit tests; sibling state assertion |
| Stable activity outputs | Sync transition, sync step, and async-resume unit tests preserving legacy aliases |
| Trusted customer event scope | Customer command emission test asserting event options |
| UI persists both paths | Transform unit tests + headed visual-editor QA |
| Transaction failure boundaries | Rollback test for selected-transition failure + durable destination test for later continuation failure |

Integration tests must create fixtures through APIs, declare module dependencies, poll deterministic state, and clean up in `finally`. They must not rely on demo data or `networkidle`.

## Findings and Remediation

### Blocking findings

None. The initial transaction ambiguity was fixed in the target spec before this readiness decision.

### Implementation watch-items

1. **Preserve public/DI signatures.** Prefer additive internal helpers and adapters.
2. **Do not treat discovery as consumption.** Always lock and re-check the exact row.
3. **Filter valid transitions by `trigger: 'auto'`.** `findValidTransitions` itself returns every outgoing trigger.
4. **Treat transition result failure as an exception before commit.** Several workflow helpers return `{ success: false }` rather than throwing.
5. **Preserve branch namespace semantics.** Use execution-token helpers rather than directly flattening branch data into instance context.
6. **Apply activity aliases in every completion path.** Transition, step, and async resume currently collect outputs in different places.
7. **Do not change events worker production code.** The current baseline already forwards the required trusted metadata and has regression coverage.
8. **Do not run migrations.** Generate and verify files only.

## Recommended Implementation Order

1. Add validator, form-transform, path-resolution, output-alias, and signal regression tests.
2. Add entity fields/index and generate migration/snapshot.
3. Implement wait registration for root/branch tokens.
4. Implement stable activity output aliases across sync/async paths.
5. Implement transactional correlated delivery and fix manual condition-first consumption.
6. Add persistent subscriber and trusted customer event options; regenerate discovery files.
7. Add editor fields/translations and transform coverage.
8. Add `TC-WF-032` and `TC-WF-033` integration coverage.
9. Run focused tests, build/typecheck/lint as justified by touched files, inspect diff, and obtain one fresh primary review plus security review because event scope and tenant isolation are touched.
10. Continue through private deployment, headed QA, durable Jira evidence, and the EPC contribution workflow gates.

## Recommendation

**READY TO IMPLEMENT.** The design is minimal for the requested behavior, reuses the current engine, explicitly handles the high-risk concurrency and tenant boundaries, and has a traceable verification plan. No production dependency, new public route, new step type, new worker, or cross-module data relationship is justified or required.
