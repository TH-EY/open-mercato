# Pre-Implementation Analysis: Finoo customer data-retention expiry

## Executive Summary

THOM-109 is feasible as one Finoo-private app-level extension and introduces no breaking public Open Mercato change. Implementation is ready after three mechanical corrections to the approved file manifest/test placement: custom fields belong in `ce.ts`, subscribers in `subscribers/*.ts`, and private provider-decoupling coverage must remain module-local. The analysis found no product or architecture blocker.

## Backward Compatibility

The current `BACKWARD_COMPATIBILITY.md` enumerates 14 categories, although the workflow text still refers to 13. All 14 were checked.

### Violations found

| # | Surface | Issue | Severity | Proposed fix |
| --- | --- | --- | --- | --- |
| 1 | Auto-discovery | Spec file manifest named `data/custom-fields.ts`, which is not a custom-entity discovery surface. | Critical before coding | Declare person-profile fields in module-root `ce.ts` exporting `entities`. |
| 2 | Auto-discovery | Spec file manifest named root `subscribers.ts`, but subscribers are discovered only from `subscribers/*.ts`. | Critical before coding | Use one default handler plus `metadata` per file under `subscribers/`. |

No removal, rename, narrowing, or incompatible behavior change was found.

### Contract-surface audit

| # | Surface | Result |
| --- | --- | --- |
| 1 | Auto-discovery conventions | Additive after the two path corrections; activate the new private module in `apps/mercato/src/modules.ts`. |
| 2 | Types/interfaces | New private settings, state, provider, and job types only. |
| 3 | Function signatures | Existing signatures unchanged; new private services only. |
| 4 | Import paths | Existing paths unchanged; documented package imports will be used. |
| 5 | Event IDs | Existing events unchanged; any new private event ID is additive. |
| 6 | Widget spot IDs | Unchanged; settings navigation/page is additive. |
| 7 | API URLs | Three new private routes are additive. |
| 8 | Database schema | Two new private tables and indexes; no core schema mutation. |
| 9 | DI service names | New stable private provider/service keys only. |
| 10 | ACL feature IDs | Reuses `customers.settings.manage` and `customers.people.view`; no stored ACL ID change. |
| 11 | Notification IDs | N/A. |
| 12 | AI IDs/overrides | N/A. |
| 13 | CLI commands | N/A. |
| 14 | Generated contracts | Generator behavior/shape unchanged; normal additive registry output only. |

### Missing BC section

None. Specification section 10 defines migration, compatibility, and rollback.

## Spec Completeness

### Missing sections

None. The approved spec includes TLDR/problem, MVP/user stories, architecture, data, APIs, UI, risks, phasing, implementation plan, integration scenarios, final compliance report, and changelog.

### Incomplete sections

| Section | Gap | Recommendation |
| --- | --- | --- |
| File manifest | Incorrect custom-field/subscriber convention paths. | Correct before Phase 1 code. |
| Optional-provider verification | References the public reduced-core decoupling test. | Keep Finoo-specific enabled/absent/failure coverage in the private module. |
| Query-index consistency | Mirror writes may bypass the normal customer CRUD indexer. | Use the canonical custom-field write path and trigger the required scoped query-index upsert after commit when the existing service does not already do so. |
| Progress transaction boundary | `ProgressService` emits after its injected EM write. | Bind settings and pending job to one transaction, enqueue after commit, and test crash/enqueue recovery. |

## AGENTS.md Compliance

### Violations

| Rule | Location | Fix |
| --- | --- | --- |
| Auto-discovered custom entities use `ce.ts` exporting `entities`. | Spec §11 manifest | Replace `data/custom-fields.ts` with `ce.ts`. |
| Subscribers live in `subscribers/*.ts` and export default handler plus `metadata`. | Spec §11 manifest | Replace root `subscribers.ts` with concrete subscriber files. |
| Public core decoupling tests must not model private app modules. | Spec §2 verification wording | Add a private module-local provider-resolution/decoupling test. |

All other checked rules are compliant or explicitly dispositioned in the implementation spec: app-level placement, scalar cross-module IDs, narrow source-owned DI providers, scoped queries, Zod, optimistic locking, mutation guards, commands, queue/progress, custom fields, guarded HTTP, i18n, design-system primitives, no cache, and self-contained integration coverage. The delivered page follows the established authenticated client-loading pattern because no safe server-page helper preserves selected-organization request context; adding such a helper would expand the shared auth/scoping contract.

## Risk Assessment

### High risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Cross-scope provider or projection query | Customer retention leaks/corrupts another organization. | Scope every query/lock/job by tenant and organization; negative integration tests. |
| Activity/expiry race | A source commit can overlap projection evaluation. | Serialize projection writers, request refresh after source success, and repair authoritatively within the hourly bound. |
| Mirror/index divergence | People filters/export disagree with the projection. | Atomic projection/mirror write, canonical index upsert after commit, hourly repair. |
| Settings committed but reconcile not enqueued | Policy remains partly projected. | Pending ProgressJob as durable intent, enqueue after commit, hourly recovery. |
| Enabled partner provider missing/failing | Affiliate/intermediary is expired. | Enabled-module detection and fail-closed evaluation. |

### Medium risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Existing partner events omit deletion | Exclusion/re-entry is delayed. | Private command/API interceptors and hourly authoritative reconciliation. |
| Large organization | Long transaction/job or queue pressure. | Keyset pages ≤200, one subject lock at a time, durable progress cursor/checkpoint. |
| Migration overlap | Fresh initialization fails. | Inspect all private migrations, generate only the intended migration/snapshot, run fresh bootstrap validation. |

### Low risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Standard custom-field status lacks a badge | Cosmetic only; filter/value remain usable. | Explicitly deferred by approved MVP. |

## Gap Analysis

### Critical gaps (block implementation)

- Correct the two auto-discovery paths before creating Phase 1 code.

### Important gaps (should address)

- Add module-local provider absence/failure tests rather than changing the public decoupling suite.
- Verify whether canonical custom-field writes already update query indexes; emit a scoped upsert after commit when they do not.
- Add the transaction/enqueue recovery regression test.
- Add `di.ts` to `finoo_intermediaries`; `finoo_affiliates` can extend its existing registrar.

### Nice-to-have gaps

- None required for MVP.

## Remediation Plan

### Before implementation (must do)

1. Correct spec manifest and verification wording.
2. Record query-index and transaction-boundary requirements in the spec.

### During implementation (add to spec)

1. Track each phase and exact verification result in `Implementation Status`.
2. Keep provider registration edits minimal and private.
3. Run `corepack yarn generate` after convention files are added.

### Post-implementation (follow up)

1. Run fresh deep review and security review.
2. Run managed integration QA and deployed headed QA before closing THOM-109.

## Recommendation

**Ready to implement after the listed spec corrections.** No major redesign, public prerequisite, or separate task is required.
