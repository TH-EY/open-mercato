# THOM-91 Pre-Implementation Analysis

## Scope

Reviewed `.ai/specs/enterprise/2026-08-14-finoo-affiliate-commission-rules.md` against the current private FINOO module, the implemented THOM-89 specification, repository compatibility rules, and the relevant module/UI/CLI/QA guidance.

## Readiness Verdict

READY for local implementation in the dedicated THOM-91 worktree. Integration and deployment remain blocked pending a stable THOM-89 baseline from its owner.

## Evidence and Decisions

- The existing THOM-89 spec makes automatic commission rules a non-goal, so THOM-91 is a separate additive enterprise spec.
- `CustomerDeal.valueAmount` (`numeric(14,2)`) and `valueCurrency` are the canonical Deal monetary fields. No FINOO-specific granted-amount field exists.
- Current FINOO commission and payout projections use non-negative whole PLN integers. The new calculation preserves that public convention.
- The existing transaction unique constraint is scoped by tenant, organization, and Deal and already provides the required Accepted re-entry/concurrent-insert idempotency boundary.
- The existing database trigger owns the first-Accepted registry. THOM-91 must extend that registry with Deal value/currency snapshots so delayed reconciliation cannot use a later Deal value.
- Existing memberships require a nullable configuration compatibility state. Using the current Deal-attribution commission in that state preserves behavior without a data rewrite.
- The existing affiliates entity already has `updated_at`; the new staff edit surface can use standard optimistic locking without a parallel version field.
- The current app-level module already owns staff affiliates, Deal attribution, transactions, and payouts, so no new module or production dependency is justified.

## Contract Review

- Database: additive nullable membership columns and additive transaction snapshot columns; existing transaction mode backfill only.
- API: additive PATCH method and additive response fields; no removal or signature change.
- Events: no new event; there is no current consumer that justifies freezing another contract surface.
- UI: one existing client DataTable island plus a focused dialog; no new route or navigation item.
- Cross-module: read-only scoped Deal lookup through the existing public customers entity; no ORM relationship.

## Required Verification

- Red-green unit tests for exact calculation and legacy/fixed snapshot resolution.
- Focused transaction creation/idempotency regression tests.
- Route/command optimistic-lock and guard-order tests.
- Migration generation review and module snapshot synchronization; never apply the migration locally.
- Generated registry refresh for the additive event.
- Focused typecheck/build and executable integration coverage in an isolated ephemeral environment.
- Fresh primary review after targeted verification.

## Blockers

- No implementation blocker.
- Integration with the shared FINOO baseline, deployment, and runtime QA are explicitly out of scope until the THOM-89 owner reports a stable baseline.

## Fresh Scope-Cohesion Review Resolution

- Financial snapshot/configuration columns remain after runtime rollback; destructive removal is a separate approval-gated migration.
- Transaction mode retains the `legacy_deal_amount` database default for mixed-version writer compatibility.
- Rule updates and first transaction creation serialize on the same scoped affiliate membership row.
- Acceptance-time semantics are explicit and implemented through the first-Accepted value/currency snapshot.
- Null mode is migration-only and cannot be restored through PATCH.
- The proposed additive event was removed because no current consumer needs it.
