# FINOO Deal affiliate transaction commission display

## TLDR

Replace the editable Deal commission amount with a read-only projection of the immutable affiliate transaction. Before the transaction exists, show an explicit pending-calculation state. Preserve the legacy attribution amount only as a compatibility source for affiliates that still have no configured commission rule.

## Overview

- Jira: THOM-99
- Target: `https://finoo.om.they.dev`
- Module: `apps/mercato/src/modules/finoo_affiliates`
- Delivery: private FINOO branch and instance only

## Problem Statement

The Deal affiliate tab currently exposes `FinooDealAttribution.commissionAmount` as an editable field even when Percentage or Fixed affiliate rules make the immutable `FinooAffiliateTransaction.commissionAmount` authoritative. This can mislead staff into thinking an edit changes an already snapshotted commission.

## Proposed Solution

- Project transaction amount, currency, status, and mode from the scoped transaction in the Deal API independently of the current attribution lifecycle.
- Render those transaction fields read-only when a transaction exists.
- Render a localized “Not calculated yet” explanation before first Accepted creates the transaction.
- Do not submit the legacy attribution amount for Percentage or Fixed affiliates.
- Keep a conditional legacy input and server-side preservation rule for nullable legacy affiliate rules.

## Architecture

The existing Deal injection widget remains the only UI surface. The existing scoped `GET /api/finoo_affiliates/deal-attributions` route remains the source of editor data and gains additive transaction and affiliate-rule fields. The existing guarded `PUT` route and command remain the mutation path.

The selectable affiliate list excludes a role-assigned user while its existing membership is inactive. The command independently rejects that inactive membership. A role-only user with no membership remains on the pre-commission-rule legacy path for backward compatibility with Deals created before affiliate membership records were introduced.

No new entity, migration, route, widget spot, event, DI key, or dependency is introduced. Transaction creation, acceptance reconciliation, payout behavior, and portal projections are unchanged.

## Data Models

No schema changes are required.

- `FinooAffiliateTransaction.commissionAmount`, `currency`, `commissionStatus`, and `commissionMode` remain immutable canonical snapshots displayed by the Deal tab.
- `FinooDealAttribution.commissionAmount` remains in the database and command snapshots for backward compatibility.
- `FinooAffiliate.commissionMode = null` continues to identify the legacy attribution-amount calculation path.

The readiness audit was aggregate-only and did not expose customer records or financial values. It found two active configured affiliates, one active transaction-backed attribution, and zero active legacy dependencies.

## API Contracts

### GET `/api/finoo_affiliates/deal-attributions`

Existing authentication, feature checks, Deal lookup, and tenant/organization predicates stay unchanged. The response adds:

- `affiliates[].commissionMode`: `percentage | fixed | null`
- `transaction`: a nullable top-level immutable projection with transaction ID, affiliate user ID, amount, currency, status, mode, and accepted timestamp
- `attribution.affiliateTransactionCurrency`: `string | null`
- `attribution.affiliateTransactionStatus`: `processing | approved | rejected | paid_out | null`
- `attribution.affiliateTransactionCommissionMode`: `legacy_deal_amount | percentage | fixed | null`

All transaction fields come from the same scoped `FinooAffiliateTransaction` row as the existing transaction ID and amount. The top-level projection remains present if an attribution is later soft-deleted or undone. Existing `affiliateProgramStatus` and nested attribution fields remain for compatibility.

### PUT `/api/finoo_affiliates/deal-attributions`

`commissionAmount` becomes optional. Existing clients that send it remain valid.

- Percentage/Fixed: omission stores `0` only for a new attribution and preserves the existing attribution amount on update. This legacy column is not a displayed or calculated result.
- Legacy null mode: the UI sends the explicit amount. If another client omits it for a new legacy attribution, the command rejects the mutation with a structured 422 instead of silently storing zero. An existing legacy attribution preserves its current amount when omitted.
- Existing inactive membership: the selector omits the user and direct PUT rejects with `422 inactive_affiliate`; it is never reclassified as legacy.

Mutation guards, optimistic locking, command logging, undo, and transaction creation remain in place.

## UI and Accessibility

- Percentage/Fixed without a transaction: show a semantic bordered information region with “Not calculated yet” and the first-Accepted snapshot explanation.
- Existing transaction: show read-only amount with returned currency and localized transaction status.
- Legacy affiliate without a transaction: show the same pending explanation plus a labeled `Input` named “Legacy commission amount” and a clear compatibility explanation. Hide it once a transaction exists so the immutable snapshot remains the only displayed amount.
- Affiliate selector, attribution-status selector, save behavior, optimistic conflict handling, responsive single-column layout, and keyboard form submission remain unchanged.
- All new strings are present in English, Polish, German, and Spanish locale files; styling uses existing semantic design-system tokens.

## Backward Compatibility

- Additive GET fields preserve existing consumers.
- Making one PUT field optional accepts a superset of the existing request contract.
- Existing callers that submit `commissionAmount` retain the old behavior.
- No historical transaction row is updated or recalculated.
- The explicit legacy branch prevents a nullable-rule affiliate from losing its only commission source.
- No public upstream contribution is part of THOM-99.

## Testing Strategy

### Focused tests

- Validator accepts omission and still accepts an explicit legacy amount.
- Widget renders the no-transaction explanation for Percentage and Fixed and omits `commissionAmount` from PUT.
- Widget renders transaction amount, currency, and status as read-only values.
- Widget keeps the transaction visible when its attribution has been undone.
- Widget renders and submits the conditional legacy amount.
- Route/command contract covers scoped canonical projection and fail-closed legacy omission.

### Integration

- Percentage and Fixed transactions return canonical immutable snapshots in the Deal projection.
- No-transaction response carries null transaction fields and the UI presents the pending state.
- Legacy fallback remains usable and does not silently become zero.
- An inactive configured affiliate is not selectable and direct PUT fails with 422.
- Cross-scope Deal access remains 404 and historical transaction snapshots remain unchanged after attribution or rule changes.

Integration fixtures are self-contained and cleaned up. Runtime QA covers desktop and narrow viewports before and after a transaction exists.

## Risks & Impact Review

### Misstating historical commission

Risk: the UI could read current rules or attribution input instead of the financial snapshot.

Mitigation: amount, currency, mode, and status are projected from the scoped transaction row and rendered together.

### Legacy data loss

Risk: optional input could coerce omission to zero.

Mitigation: the validator no longer coerces absent input, existing attribution amounts are preserved, and new legacy attribution omission fails with 422.

### Cross-scope exposure

Risk: joining affiliate configuration could expose another tenant or organization.

Mitigation: membership and transaction lookups retain explicit tenant, organization, active/deleted predicates; integration coverage verifies 404 across scope.

### Contract regression

Risk: removing the column or required request field could break existing clients.

Mitigation: no schema removal; GET changes are additive; PUT accepts both old and new payloads.

## Final Compliance Report

- Scope is confined to private FINOO `finoo_affiliates` Deal editor/projection, tests, and locales.
- THOM-100 Intermediaries code and active worktree are excluded.
- No dependency, migration, public contract removal, historical recalculation, or payout mutation is introduced.
- Implementation must pass focused tests, typecheck/lint/generation gates, integration coverage, exact-revision deployment, headed QA, and fresh review before Jira closure.

## Open Questions

None. The 2026-08-17 aggregate-only live-data audit found no active affiliate, attribution, or transaction using `legacy_deal_amount`; existing code and THOM-91 define the compatibility behavior for other environments.

## Changelog

### 2026-08-17

- Initial THOM-99 private FINOO specification and live-data readiness decision.

### 2026-08-18

- Kept the canonical transaction projection independent of attribution undo and prevented inactive configured memberships from falling back to legacy editing.
