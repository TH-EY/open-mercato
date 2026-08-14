# Pre-Implementation Analysis: Finoo Intermediary Customer Portal

## Executive Summary

The amended THOM-90 specification is implementation-ready. The design is additive, isolated in one private app module, backed by a fresh authenticated FINOO configuration snapshot, and has no backward-compatibility violation across the current 14 protected contract categories. No unresolved business or architecture blocker remains; the main implementation gates are fail-closed authorization, note encryption, exact stage/role validation, generated migration review, and self-contained integration proof.

## Evidence Window

- Specification: `.ai/specs/enterprise/2026-08-13-finoo-intermediary-portal.md`, reread in full after Q1–Q3 approval.
- Baseline: `origin/fork/finoo` and task branch at `5e2e6350208f40a550b1b57c517a897d040598c5` on 2026-08-13.
- Live read-only FINOO snapshot on 2026-08-13: exact role, role features, pipeline/stages, and scoped custom-field definitions.
- Code seams inspected: Customer Accounts portal auth/RBAC/setup; Customer Deal/stage/link entities and detail injection; custom-field routing/value loading; interaction visibility/read model; optimistic-lock helpers; module override/generation/testing contracts.
- Fresh-context scope review: KEEP as one independently deployable capability.

## Backward Compatibility

### Violations Found

None. The current repository contract has 14 categories; all are covered below.

| # | Surface | Impact | Severity | Required implementation discipline |
|---|---------|--------|----------|------------------------------------|
| 1 | Auto-discovery conventions | Additive new app module files/routes/widgets/entities/migration | None | Keep required export names and run generation; never hand-edit generated registries |
| 2 | Exported TypeScript types | Additive module-local schemas/DTOs/entities | None | Do not narrow any existing CRM/portal type |
| 3 | Public function signatures | Existing auth, encryption, custom-field, command, UI, and injection helpers are consumed unchanged | None | Use documented package imports and current signatures |
| 4 | Import paths | No file move/removal | None | Preserve all existing import paths |
| 5 | Event IDs | No event is needed | None | Do not introduce speculative events without a current consumer |
| 6 | Widget injection spot IDs | Existing Deal-tab and portal-menu spots are consumed | None | Do not rename/remove/change host context; new widget IDs become stable module contracts |
| 7 | API route URLs | New private module routes only | None | Export `openApi`/per-method metadata and keep response shapes additive once shipped |
| 8 | Database schema | Two additive private tables/indexes/constraints | None | Generate migration, inspect SQL, no core schema mutation/backfill/destructive statement |
| 9 | DI service names | No new public DI service required by the spec | None | If local registration proves necessary, use one additive stable name only |
| 10 | ACL feature IDs | Three additive IDs | None | Treat IDs as frozen after delivery; never authorize by mutable role slug alone |
| 11 | Notification type IDs | Not used | None | N/A |
| 12 | AI agent/tool/UI/override IDs | Not used | None | N/A |
| 13 | CLI commands | Not changed | None | N/A |
| 14 | Generated-file contracts | Generator output changes additively due to new module | None | Run generator and verify export/BootstrapData shapes remain unchanged |

### Migration and BC Section

Present and complete. No deprecation bridge or upgrade note is required because no existing contract is removed, renamed, narrowed, or repurposed.

## Spec Completeness

### Missing Sections

None.

### Completed Sections

| Section | Status | Evidence |
|---------|--------|----------|
| TLDR / scope / non-goals | Complete | Intermediary-only private stream and Affiliate boundary are explicit |
| Overview / problem / proposed solution | Complete | One app module, two entities, exact access predicate |
| Architecture | Complete | Cross-module scalar IDs, module-owned glue, no event/worker need |
| Frontend architecture | Complete | Server/client map, client ledger rules, dependency and bundle guardrails |
| Data models | Complete | Columns, tenancy, lifecycle, indexes, active uniqueness, encryption |
| API contracts | Complete | Admin/portal routes, guards, inputs, outputs, errors, pagination |
| UI/UX and i18n | Complete | Staff tab, portal pages, guarded mutations, DS and keyboard contracts |
| Commands/undo | Complete | Seven mutations with execute/undo semantics and optimistic versions |
| Performance/cache | Complete | Keyset/batching/indexes, no-cache MVP rationale |
| Integration coverage | Complete | Ten self-contained API/UI/security/concurrency cases |
| Risks | Complete | Concrete high/critical cases, mitigation and residual risk |
| Compliance/changelog/review | Complete | Compliance report and fresh-context KEEP verdict appended |

## AGENTS.md Compliance

### Violations

None in the specification.

### Key Compliance Checks

| Rule | Status | Evidence / implementation gate |
|------|--------|--------------------------------|
| Correct private app placement and plural snake_case module ID | Pass | `apps/mercato/src/modules/finoo_intermediaries` |
| No direct ORM relationships between modules | Pass | Deal/user/role/stage are scalar UUIDs; only same-module note→assignment may be ORM-linked |
| Every scoped query filters tenant + organization | Pass | Central authorization predicate plus route-level negative tests |
| Inputs validated with zod | Pass | Validators required for every query/body/cursor/status |
| Sensitive free text uses module encryption map | Pass | Note body in `encryption.ts`; reads via scoped decryption helpers |
| Custom writes use mutation guards and commands | Pass | Explicit route mappings and seven command contracts |
| Backend/portal HTTP uses `apiCall` family | Pass | No raw fetch permitted |
| Lists/forms use canonical UI mechanisms | Pass | DataTable, guarded mutation, shared DS primitives |
| Dialog keyboard and icon accessibility | Pass | Cmd/Ctrl+Enter, Escape, icon `aria-label` required |
| i18n for all user-facing strings | Pass | EN/PL module dictionaries and translation helpers |
| Page size ≤100 | Pass | All list endpoints cap at 100; portal default 50 |
| No handwritten migration | Pass | `corepack yarn db:generate`, SQL review, no local migrate |
| Self-contained integration fixtures | Pass | Role/stage/definitions/users/Deal/links/data created and cleaned by tests |

## Code-Backed Readiness Findings

### Ready seams

- Portal auth provides customer user, tenant, organization, and resolved feature context; the module can require both the feature and its stricter assignment/role/stage predicate.
- Customer-role setup augments existing roles but does not create a missing custom role, matching the fail-closed reuse contract.
- Deal owns `pipelineStageId`; PipelineStage is scoped and UUID-backed. The exact label is checked once, while later visibility compares UUID.
- Deal Person links have an explicit `isPrimary`; Company links do not. The spec now resolves Company deterministically by oldest active link and tests this rule.
- `loadCustomFieldValues` supports record-specific tenant/organization maps and encrypted custom-field reads.
- Interaction records contain substantially more data than approved; a fresh DTO allowlist can prevent accidental spread/leakage. MVP excludes all email/private rows and activity writes.
- Optimistic-lock helpers and command infrastructure support module-row versions without reusing the Deal timestamp.
- Deal-detail injection and portal navigation/page auto-discovery allow the staff/portal UI without editing core CRM components.

### Live configuration confirmed

- `intermediary` role exists and currently has no features, so setup/deployment must add only `portal.finoo_intermediaries.view`.
- Exact eligible stage is `Sent To Partners`; the separate `Sent To Intermediaries` stage proves partial matching is unsafe.
- `turnover`, `arrears`, `business_start_date`, `industry`, and Person `mobile` definitions exist with the required kinds.
- Company `industry` also exists as a native text column, so the implementation must explicitly read the configured dictionary custom field and resolve its entry label.

## Risk Assessment

### High/Critical Risks

| Risk | Impact | Mitigation / verifier |
|------|--------|-----------------------|
| Incomplete portal scope predicate | Cross-tenant/intermediary PII leak | One fail-closed helper plus per-route negative tests for user, tenant, org, role, assignment, stage, deletion, forged IDs |
| Canonical record spreading | Activity/contact/body/recipient leak | Construct explicit DTOs; assert forbidden keys absent; exclude email/private entries |
| Mutable stage or role name used as ongoing auth | Wrong Deal access after rename/collision | Capture scoped UUIDs at assignment, then validate UUID/membership on every request |
| Plaintext notes | Sensitive free-text exposure at rest | Encryption map, decryption-aware reads, raw database ciphertext assertion |
| Reassignment note leak | New intermediary reads former intermediary notes | Author filter for portal notes, staff-only all-note projection, reassignment integration case |
| Lost updates | Assignment/status/note overwrite | Transactional expected timestamp, structured 409, guarded retry UI, two-writer tests |
| Migration drift/private deployment failure | Wrong schema or production outage | Additive generated migration review, backup/rollback, provenance, no deploy before all reviews |

### Medium Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Company association ambiguity | Wrong Company data shown | Deterministic oldest active scoped link; multiple-link fixture |
| Custom definition drift | Wrong/null field or native/custom collision | Exact key/kind/definition validation; operational failure rather than fallback |
| N+1 projection | Slow list/database pressure | Keyset ≤100, batched links/entities/profiles/custom fields/dictionaries, query-count evidence |
| Parallel THOM-89 registry/generated drift | Integration conflict | Keep streams independent; integrate only fresh deployed FINOO baseline and rerun gates |

### Low Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Missing canonical activity direction | `direction` may be null for non-email interactions | Contract permits null unless a supported canonical scalar exists; never infer from body/source text |
| Stage label rename after assignment | Staff UI text differs from captured evidence | UUID remains authority; display current scoped label separately |

## Gap Analysis

### Critical Gaps (Block Implementation)

None.

### Important Implementation Checks

1. Verify the exact generated route filename/method convention before creating API files; use the baseline's actual auto-discovery form rather than relying on old documentation examples.
2. Resolve dictionary entry labels through the existing dictionary read seam and keep raw entry IDs out of portal responses.
3. Ensure the active-assignment uniqueness constraint is generated as a partial unique index and that undo checks for a newer active replacement.
4. Use the module row's `updatedAt` in every write and make stale tests bump state invisible to the submitted payload.
5. Treat the role's current empty feature list as expected pre-deployment state; setup and deployment read-back must prove only the intended portal feature is added.

### Nice-to-Have Gaps

None belong in THOM-90 MVP. Generic partner configuration, automatic dispatch, broader activity direction enrichment, notifications, cache, and upstream APIs remain explicitly deferred.

## Remediation Plan

### Before Implementation

Complete: Q1–Q3 approved, full spec written, live snapshot captured, 14-surface BC audit completed, and fresh-context scope review returned KEEP.

### During Implementation

1. Follow the five spec phases in order and begin each behavior with a failing focused test.
2. Inspect generated artifacts after `generate`/`db:generate`; reject unrelated drift.
3. Keep one write lane and never touch `finoo_affiliates` or THOM-89.
4. Run targeted tests after each phase and the complete integration/security matrix before review.

### Before Private Deployment

1. One fresh primary review plus orthogonal security review, with validated findings fixed and affected checks rerun.
2. Integrate the freshly deployed FINOO baseline and rerun generation, tests, typecheck/lint, and integration suite.
3. Require backup, immutable artifact provenance, safe rollback, headed desktop+narrow QA, Jira evidence, and release-evidence review.
4. Preserve the existing CTO password; do not read, reset, rotate, or replace it.

## Recommendation

**Ready to implement.** No additional user decision is required. This verdict authorizes the local implementation already requested under THOM-90; it does not authorize an upstream contribution/PR or a deployment before the specification's review, verification, and private-release gates pass.

## Implementation Read-Back — 2026-08-13

The local private implementation completed the readiness scope. It remains undeployed.

- `finoo_intermediaries` is isolated under the app-specific module root; no Affiliate files changed.
- All staff assignment and portal status/note mutations use registered undoable commands, transactions, optimistic locking, current authorization checks, and scoped audit metadata.
- Assignment access captures role/stage UUIDs, rejects ambiguous canonical pipeline/stage/role configuration, and rechecks current user membership, feature, scope, Deal stage, and assignment on each portal request.
- Notes are encrypted at rest and redacted from generic audit snapshots; portal reads remain author-scoped after reassignment while staff reads are keyset-paginated.
- Activities use an allowlisted projection ordered by `occurredAt DESC NULLS LAST, id DESC`, including cursor traversal into null occurrence timestamps.
- Fresh verification: 29 focused unit tests passed; 10 self-contained integration/headed tests passed in an isolated generated/migrated/built environment; app typecheck, lint with zero errors, client-boundary check, and build/generation gates passed.
- Primary and security reviews produced actionable findings; all validated findings were remediated and the affected checks were rerun. Deployment, release evidence, and Jira completion remain separate gates.
