# FINOO Affiliate Commission Rules

## TLDR

- Jira: THOM-91.
- Target: private FINOO app module `apps/mercato/src/modules/finoo_affiliates` only.
- Staff can configure each affiliate with either a percentage of the accepted Deal value or a fixed whole-PLN amount.
- The first successful Accepted transition calculates and snapshots the rule inputs and final commission on the affiliate transaction.
- Later affiliate configuration or Deal value changes never rewrite an existing transaction.
- Affiliates without a configured rule preserve the current Deal-attribution commission amount.
- No upstream contribution, deployment, AWS, ECR, FINOO runtime, or integration action is part of this change.

## Overview

The existing FINOO affiliate program stores a staff-entered whole-PLN commission on a Deal attribution and copies that value into a transaction when the Deal first becomes Accepted. THOM-91 adds an affiliate-specific rule for future transactions while preserving existing rows and current behavior for affiliates that have not yet been configured.

This is an app-level external extension. It does not change the customers module, the Deal API, shared packages, or the THOM-89 payout state machine.

## Problem Statement

FINOO needs different commercial terms per affiliate. Staff must be able to choose between a percentage and a fixed commission, and the amount owed for an accepted Deal must remain explainable even after the affiliate terms or Deal value change.

## Goals and Non-Goals

### Goals

- Store one optional commission rule on each tenant- and organization-scoped affiliate membership.
- Support `percentage` and `fixed` modes.
- Snapshot `CustomerDeal.valueAmount` and `valueCurrency` in the first-Accepted registry and use that immutable value as the canonical percentage base.
- Calculate once when the first idempotent affiliate transaction is created for an Accepted Deal, using the first-Accepted value snapshot.
- Store immutable rule inputs and the calculated whole-PLN result on the transaction.
- Preserve the existing unique Deal transaction guard and Accepted re-entry behavior.
- Preserve the existing Deal-attribution commission for affiliates without a new rule.
- Provide a staff UI and API with optimistic locking.
- Add unit, route/command, migration, and integration coverage.

### Non-Goals

- Recalculating or backfilling historical transaction amounts.
- Changing payout behavior, transaction status behavior, Deal attribution ownership, or portal permissions.
- Supporting non-PLN rules, tiered rates, date ranges, caps, floors, bonuses, or rule version history.
- Removing the existing Deal-attribution commission field.
- Upstream contribution, PR creation, deployment, or runtime validation.

## Confirmed Business Rules

1. A configured affiliate has exactly one mode: `percentage` or `fixed`.
2. Percentage is stored in basis points (`commission_rate_bps`), where 100 basis points equals 1%.
3. Percentage values are greater than 0 and at most 10,000 basis points.
4. Fixed values are non-negative whole PLN and at most PostgreSQL `int` maximum.
5. The percentage base is `CustomerDeal.valueAmount` at the first Accepted stage transition, stored with its currency in `FinooDealAcceptance`.
6. A percentage rule requires Deal currency `PLN`; a missing, malformed, negative, or non-PLN value prevents transaction creation and produces a structured internal error for reconciliation/diagnosis.
7. Percentage results round half up to the nearest whole PLN using integer arithmetic. Floating-point arithmetic is forbidden.
8. A null commission mode is a compatibility state for memberships created before THOM-91. Its transaction uses the Deal attribution's existing `commissionAmount` unchanged.
9. The first successfully inserted transaction is authoritative. A retry or Accepted status re-entry returns the existing transaction without recalculation, and delayed reconciliation still uses the first-Accepted value snapshot.
10. Editing an affiliate rule changes future transactions only.

## Architecture

### Extension Boundary

All production code remains in `apps/mercato/src/modules/finoo_affiliates`. The feature reads the customers module's public `CustomerDeal` entity through the existing cross-module query pattern already used by FINOO. It adds no ORM relationship.

### Calculation Flow

1. The existing Deal subscriber/reconciliation path detects an Accepted Deal.
2. `createAffiliateTransactionForDeal` confirms acceptance, attribution, Deal, and active affiliate membership in the tenant and organization scope.
3. Transaction creation takes a pessimistic write lock on the same affiliate membership row used by the settings command. Creation-first snapshots the old rule before an update can commit; update-first makes creation use the new rule.
4. It resolves the affiliate rule:
   - null mode: snapshot the legacy Deal-attribution amount;
   - fixed: snapshot the configured fixed amount;
   - percentage: validate the Deal PLN value and calculate the amount with exact integer arithmetic.
5. It inserts one transaction under the existing scoped unique Deal constraint.
6. Concurrent or repeated calls return the already-inserted transaction.

### Server / Client Boundary

- The affiliates page remains a server shell with one existing client DataTable island.
- The commission editor is a small client dialog opened from a stable `edit` row action.
- Reads use the existing affiliates collection endpoint.
- Writes use the same collection endpoint with `PATCH`, route mutation guards, a command handler, and optimistic locking.

## Data Models

### `FinooAffiliate` additive columns

| Field | Database | Type | Rules |
|---|---|---|---|
| `commissionMode` | `commission_mode` | nullable text | null, `percentage`, or `fixed` |
| `commissionRateBps` | `commission_rate_bps` | nullable int | populated only for percentage |
| `commissionFixedAmount` | `commission_fixed_amount` | nullable int | populated only for fixed; whole PLN |

`updated_at` remains the optimistic-lock version. The migration leaves all three columns null for existing memberships.

### `FinooAffiliateTransaction` additive snapshot columns

| Field | Database | Type | Rules |
|---|---|---|---|
| `commissionMode` | `commission_mode` | text | `legacy_deal_amount`, `percentage`, or `fixed` |
| `commissionRateBps` | `commission_rate_bps` | nullable int | snapshot for percentage |
| `commissionFixedAmount` | `commission_fixed_amount` | nullable int | snapshot for fixed |
| `commissionBaseAmount` | `commission_base_amount` | nullable numeric(14,2) | accepted Deal value snapshot for percentage |

The existing `commission_amount` remains the final whole-PLN amount used by staff, portal, and payout projections. Existing transaction rows are backfilled to `legacy_deal_amount`; their amount is unchanged.

### `FinooDealAcceptance` additive value snapshot columns

| Field | Database | Type | Rules |
|---|---|---|---|
| `dealValueAmount` | `deal_value_amount` | nullable numeric(14,2) | first-Accepted Deal value |
| `dealValueCurrency` | `deal_value_currency` | nullable text | first-Accepted Deal currency |

The capture trigger writes both fields with the first accepted transition. Existing acceptance rows are backfilled once from the current scoped Deal during migration; a still-null or non-PLN snapshot fails closed for percentage rules.

### Exact Percentage Formula

Parse `valueAmount` into integer grosz (`baseMinor`). Then:

```text
commissionWholePln = floor((baseMinor * rateBps + 500000) / 1000000)
```

The denominator combines 100 grosz per PLN and 10,000 basis points per 100%. The added half denominator implements round-half-up. The result must fit a signed 32-bit integer.

## API Contracts

### `GET /api/finoo_affiliates/affiliates`

Each item adds nullable `commissionMode`, `commissionRateBps`, and `commissionFixedAmount`. Existing fields and pagination remain unchanged.

### `PATCH /api/finoo_affiliates/affiliates`

Requires `finoo_affiliates.manage`. Request body:

```json
{
  "id": "affiliate-uuid",
  "commissionMode": "percentage",
  "commissionRateBps": 750,
  "commissionFixedAmount": null,
  "updatedAt": "2026-08-14T10:00:00.000Z"
}
```

The fixed variant requires `commissionFixedAmount` and requires `commissionRateBps` to be null. The percentage variant requires `commissionRateBps` and requires `commissionFixedAmount` to be null. The response returns the normalized settings and fresh `updatedAt`.

The route runs mutation guards before the command bus. The command locks the scoped membership, enforces the expected version, and writes the normalized settings. The transaction creator locks the same row before reading the rule. Stale writes return the shared structured 409 conflict body.

Null mode is migration-only. PATCH rejects attempts to clear a configured rule back to the legacy Deal-attribution behavior.

### `GET /api/finoo_affiliates/transactions`

Staff transaction items add the immutable `commissionMode`, `commissionRateBps`, `commissionFixedAmount`, and `commissionBaseAmount` snapshot fields. Portal projections continue to expose only the calculated amount and status so current affiliate configuration cannot be mistaken for historical terms.

## Authorization and Security

- List reads require `finoo_affiliates.view`.
- Commission updates require `finoo_affiliates.manage`.
- Every membership and transaction query includes `tenantId` and `organizationId`.
- The command loads the affiliate by scoped ID and `deletedAt: null` under a pessimistic write lock.
- No bank data, credentials, or new external service calls are introduced.

## UI/UX

- The affiliates DataTable displays a Commission column using localized text.
- Staff with manage permission see an `edit` row action.
- The dialog includes a mode select and conditionally shows either percentage or fixed amount.
- Percentage accepts values in percent with at most two decimals and converts them to basis points before sending.
- Fixed commission accepts non-negative whole PLN.
- `Cmd/Ctrl+Enter` submits and `Escape` cancels.
- Save success uses a localized flash message. Validation, server failure, and optimistic-lock conflict are localized and preserve the dialog state.
- No nested card layout or hardcoded status colors are added.

## Migration and Backward Compatibility

- The schema migration is additive only.
- Existing affiliate settings remain null and therefore retain the Deal-attribution commission behavior.
- `commission_mode` is added with and retains a database default of `legacy_deal_amount`, so pre-THOM-91 writers remain valid during a mixed-version window. Existing transactions receive that mode; no amount is recalculated.
- The first-Accepted trigger is replaced in the same migration so new acceptance rows snapshot Deal value and currency. Existing acceptance rows receive a one-time best-effort scoped Deal backfill.
- Existing routes, event IDs, widget spots, Deal fields, portal responses, transaction status rules, and payout behavior remain compatible.
- The new response fields are additive contract surfaces.
- Runtime rollback is code-only and leaves all nine additive financial/configuration columns and their data intact. Any later column removal is a separate destructive, approval-gated migration requiring proof that no THOM-91 records depend on the snapshots.

## Implementation Plan

1. Add validation and exact commission-calculation tests, then implement the pure resolver.
2. Add membership configuration and transaction snapshot entity fields plus migration/snapshot updates.
3. Integrate the resolver into idempotent transaction creation and extend service tests.
4. Add the guarded command and collection PATCH route with route/command tests.
5. Extend staff projections, DataTable dialog, and all four locale files.
6. Add executable API/UI integration coverage in the module `__integration__` folder.
7. Run generation, focused tests, typecheck/build gates, migration no-op verification, and fresh review.

## Testing Strategy

### Unit and Service

- Percentage parsing and exact calculation: normal values, two-decimal values, half-up boundary, 100%, zero/malformed/negative/missing/non-PLN base, and overflow.
- Fixed and legacy snapshots.
- First Accepted creation persists all snapshot inputs and final result.
- Later affiliate/Deal edits do not mutate an existing transaction.
- Accepted re-entry and concurrent insertion remain idempotent.
- A controlled concurrency test proves creation-first uses the old rule and update-first uses the new rule by serializing on the membership row.
- Delayed reconciliation after a Deal edit uses the value captured at first Accepted.
- Reconciliation isolates an invalid first Deal, continues with later rows, and advances continuation batches with a stable acceptance cursor; the next scheduled root run retries failed rows.

### Route and Command

- Percentage and fixed settings persist with tenant/organization scope.
- Invalid mode/value combinations return 400.
- Missing manage feature is rejected by metadata/guards.
- Stale `updatedAt` returns a structured 409 conflict.
- The route invokes mutation guards before the command bus.

### Integration

- API: configure percentage, accept a PLN Deal with `valueAmount`, verify calculated transaction and immutable snapshots, edit the rule, and verify the existing transaction is unchanged.
- API: configure fixed, accept another Deal, and verify the fixed result.
- API: affiliate without configuration continues to use the Deal-attribution amount.
- DB/API: capture a percentage base at first Accepted while transaction creation is unavailable, edit the Deal, then prove delayed creation uses the original captured value.
- UI: open the affiliate row action, switch modes, save and reload both field types, and verify keyboard submit/cancel and accessible labels.
- Each test creates and removes its own fixtures and does not depend on seeded/demo data.

### Field Persistence Matrix

| Field group | Create/default | Update | Read-back | Omitted/partial input | Immutability proof |
| --- | --- | --- | --- | --- | --- |
| Affiliate `commissionMode`, `commissionRateBps`, `commissionFixedAmount` | Existing and new affiliates remain `null`/legacy until explicitly configured. | Guarded PATCH accepts one complete percentage or fixed variant with optimistic locking. | Affiliate list returns the persisted mode and matching value after reload. | The discriminated validator rejects incomplete, mixed, null, or mismatched variants; PATCH does not merge partial rule fragments. | A later rule update does not alter any existing transaction snapshot. |
| Acceptance `dealValueAmount`, `dealValueCurrency` | Captured once when the Deal first enters Accepted. | No update contract. | Transaction creation reads the first-Accepted value snapshot. | Missing/non-PLN values preserve the configured rule snapshot but produce no calculated transaction. | Later Deal value/currency edits and Accepted re-entry do not change the acceptance snapshot. |
| Transaction `commissionMode`, `commissionRateBps`, `commissionFixedAmount`, `commissionBaseAmount`, `commissionAmount` | Written atomically on first transaction creation; legacy rows default to `legacy_deal_amount`. | No update contract. | Staff transaction API returns all persisted snapshot fields. | Non-applicable fields are `null`; no current affiliate or Deal values are substituted on read. | API/DB integration compares the complete row before and after rule/Deal edits and exercises both lock orderings. |

## Risks & Impact Review

### Retrospective Recalculation

Risk: reading current affiliate settings when displaying or paying an old transaction could change the amount owed.

Mitigation: every required rule input and the result are transaction columns; projections read the transaction only.

### Decimal and Rounding Drift

Risk: JavaScript floating point could produce inconsistent whole-PLN results.

Mitigation: parse the two-decimal Deal amount and calculate with `BigInt`; unit-test rounding boundaries.

### Missing or Non-PLN Deal Value

Risk: silently treating invalid input as zero could create an incorrect transaction.

Mitigation: percentage rules fail closed with an internal diagnostic error. Correcting the Deal after acceptance does not alter the captured base; a new business correction flow would require separate authorization.

### Concurrent Acceptance

Risk: two accepted-event paths calculate or insert twice.

Mitigation: retain the scoped unique Deal constraint and concurrent winner read-back.

### Rule Update During First Transaction Creation

Risk: a settings update can race with the first immutable transaction snapshot.

Mitigation: both paths take a pessimistic write lock on the same scoped affiliate row. The lock acquisition order defines which rule applies and is covered by a controlled concurrency test.

### Legacy Membership Regression

Risk: nullable configuration could inadvertently make existing commissions zero.

Mitigation: null mode explicitly snapshots the current Deal-attribution amount and is covered by regression tests.

## Open Questions

None. The existing code establishes the canonical Deal field, currency representation, legacy compatibility path, and current whole-PLN payout convention.

## Changelog

### 2026-08-14

- Initial THOM-91 private FINOO specification.
