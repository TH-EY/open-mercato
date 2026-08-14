# Pre-Implementation Analysis — Finoo Affiliate Program, Transactions, and Payouts

Date: 2026-08-13

Jira: THOM-89

Specification: `.ai/specs/enterprise/2026-08-12-finoo-affiliate-portal-and-attribution.md`

## Executive Summary

The specification is ready for implementation as a private FINOO app-module extension. The lifecycle is cohesive: invitation and membership, link activation, Deal attribution, first post-deployment Accepted transaction, controlled review, encrypted affiliate profile, and manual payout recording.

The initial audit found compatibility, durability, privacy, overflow, and framework-fit gaps. Each blocker was resolved in the specification and independently re-reviewed. No core module change, new production dependency, public contribution, automatic historical liability, or banking integration is required.

Recommendation: **READY**.

## Backward Compatibility Audit

All 14 current compatibility categories were checked against the deployed THOM-88 code.

| Surface | Initial issue | Resolution | Status |
|---|---|---|---|
| Dashboard API/widget | Existing `transactions` means first Completed | Preserve it; add `affiliateTransactions` for Accepted ledger data and a new widget identity | Pass |
| Deal-attribution command | Proposed post-transaction lock narrowed deployed mutation behavior | Keep existing endpoint/command fully writable; later edits do not rewrite immutable transaction snapshots | Pass |
| Status enum/data | Proposed widening/rewrite could break exhaustive clients | Keep legacy `finoo_commission_status` and `waiting`; introduce separate transaction dictionary and additive projection field | Pass |
| Module dependencies | Existing scheduler was omitted | Retain `scheduler`; add progress/queue requirements | Pass |
| CLI/deprecation | Repair command unnamed and waiting incorrectly deprecated | Keep waiting non-deprecated; define exact dry-run/apply repair command | Pass |
| Remaining contract categories | No removal/rename/narrowing found | Additive entities, routes, events, ACLs, DI registrations, and generated artifacts only | Pass |

## Spec Completeness and Architecture

| Area | Decision | Status |
|---|---|---|
| Scope cohesion | One independently deployable affiliate lifecycle; do not split | Pass |
| Cross-module coupling | Scalar IDs/snapshots, existing APIs/events, no ORM relationships | Pass |
| Invitation recovery | Best-effort inline hooks plus authoritative ensure, lazy portal reconciliation, and idempotent CLI repair | Pass |
| Accepted idempotency | Post-deployment trigger registry plus unique transaction Deal identity | Pass |
| Historical liabilities | No automatic historical Accepted/transaction creation | Pass |
| Payout integrity | Persistent preview reservation binds exact selection/profile/amount; locked atomic confirmation | Pass |
| Queue idempotency | Duplicate progress/queue jobs may exist but converge on one database-unique payout | Pass |
| Money range | Per-transaction integer PLN retained; aggregate payout values use bigint and decimal-string APIs | Pass |
| Bank privacy | Platform encryption; profile command is non-undoable with `skipLog: true`; no bank values in events/progress/audit | Pass |
| Optimistic locking | DI-aware command guard; all transaction/profile versions revalidated under lock | Pass |

## AGENTS.md and Framework Compliance

- App-specific code remains under `apps/mercato/src/modules/finoo_affiliates`.
- Existing module routes, events, command IDs, widget IDs, scheduler work, signup behavior, and click tracking remain operational.
- New user-editable entities include `updated_at`; custom action commands use the DI-aware optimistic-lock seam.
- Every query and write is tenant- and organization-scoped; portal identity is derived from the authenticated customer user and active membership.
- Sensitive data uses encryption maps and decryption-aware reads.
- Staff and portal APIs use feature guards; page visibility and action visibility are independently gated.
- Lists use DataTable. Current unrestricted row selection is retained and the payout preview is the authoritative validity gate.
- Payout confirmation uses ProgressJob and queue contracts; no custom queue or polling loop is introduced.
- All user-facing strings use module i18n files and design-system primitives/tokens.
- Database schema changes are additive and will be generated/reviewed without applying local migrations.

## Risks and Mitigations

| Risk | Mitigation | Verification |
|---|---|---|
| Duplicate commission after Accepted re-entry | Trigger `ON CONFLICT DO NOTHING` plus unique scoped transaction Deal | Unit concurrency test and TC-011 |
| Duplicate payout under retry/concurrency | Unique preview/reference and payout reference; pessimistic locks; idempotent worker | Two-contender test and TC-015 |
| Stale payout/profile selection | Binding hash and explicit affiliate/transaction versions; structured 409 | Route/service tests and TC-014/015 |
| Cross-affiliate or cross-tenant disclosure | Trusted scope on every query plus active membership check | Negative API/integration coverage |
| Bank-data disclosure | Encryption, minimal response shapes, `skipLog: true`, no sensitive event/job metadata | Decrypted audit/output assertions and security review |
| Missed invitation event | Explicit ensure, lazy authenticated activation, scoped repair CLI | TC-009 simulated missed hook |
| Legacy runtime regression | Preserve old API semantics and run TC-001..008 unchanged except additive assertions | Regression suite |
| App client-boundary drift | Server page roots, isolated client islands, focused source/LOC test | Focused Jest/source check plus Playwright |

## Gap Analysis and Resolutions

1. Preview-to-confirm snapshot integrity was initially incomplete. The spec now binds the server-side reservation to canonical selection, versions, affiliate/profile, amount, currency, and bank-profile hash.
2. Historical backfill could have created unapproved liabilities from mutable current Deal data. Automatic historical transaction creation is now forbidden.
3. Existing API meanings would have been changed. Separate additive fields/dictionaries preserve deployed clients.
4. Customer-account events are not persistent trusted-scope events. They are now optional accelerators, not durability guarantees.
5. Progress metadata cannot enforce one job. The module-owned reservation protects the financial result and explicitly permits convergent duplicate jobs.
6. Command redo input would have copied bank values into audit logs. Profile writes now use `skipLog: true` and create no ActionLog.
7. Aggregate payout totals could overflow PostgreSQL integer. Aggregate storage uses bigint and JSON uses decimal strings.
8. DataTable cannot restrict selection per row. All rows remain selectable; preview rejects invalid sets before any mutation.

## Implementation Sequence

1. Model and compatibility: entities, validators, dictionaries, ACL, events, DI, encryption, migration, trigger, repair contract.
2. Membership lifecycle: ensure/activate/reconciliation commands, APIs, hooks, CLI, Affiliates staff UI.
3. Accepted transactions: synchronization, transitions, additive Deal/dashboard projections, staff Transactions UI.
4. Profiles and payouts: encrypted profile, preview reservation, locked compound payout, worker/progress, staff/portal payout UI.
5. Generation, focused tests, unchanged regression suite, fully managed ephemeral integration tests, primary/security review, signed commit, FINOO-only deployment, headed QA, and Jira evidence.

## Independent Review Outcomes

- Scope cohesion: PASS after exact preview binding and no-history-liability amendments.
- Backward compatibility: PASS after preserving Completed, waiting, attribution mutation, scheduler, and naming the repair CLI.
- Data/architecture: PASS after reconciliation, preview reservation, bigint, `skipLog`, and DI-aware locking amendments.
- UI/test fit: PASS after canonical selection/preview validation, explicit permission presentation gates, app boundary test, and deterministic invitation-test cleanup.

## Recommendation

**READY FOR IMPLEMENTATION.** No unresolved architectural, compatibility, security-design, framework, or testability blocker remains. Implementation must stop if it discovers that any required behavior needs a core contract change or creates historical financial rows not listed in this approved specification.
