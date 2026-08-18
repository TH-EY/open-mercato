# FINOO Visible Operation Errors

## TLDR

Audit every existing user-triggered mutation in the private FINOO Affiliate and Intermediary UI. A failure may no longer exist only in the console: it must produce a localized inline error, flash, shared conflict surface, or failed progress job. Business commands and success behavior remain unchanged.

## Overview

- Jira: THOM-103
- Target: `https://finoo.om.they.dev`
- Modules: `apps/mercato/src/modules/finoo_affiliates`, `apps/mercato/src/modules/finoo_intermediaries`
- Delivery: private FINOO branch and instance only
- Related specifications: `.ai/specs/enterprise/2026-08-18-finoo-batch-payouts-and-visible-errors.md`, `.ai/specs/enterprise/2026-08-18-finoo-bulk-intermediary-assignment.md`

## Problem Statement

Several FINOO clients catch or propagate rejected mutation promises without a guaranteed visible error. The reported payout failure is one instance of the general problem: staff click an action, the request fails, and the UI can appear unchanged while the meaningful error exists only in logs or the browser console.

## Proposed Solution

Inventory the existing user-triggered mutations in both modules and apply one established failure surface to each. This is a presentation-only audit except where a route currently loses its structured error body; no business-state transition, ACL, endpoint path, persistence model, or success response changes.

### In-scope action inventory

| Module surface | User actions | Required failure surface |
|----------------|--------------|--------------------------|
| Affiliate transactions | accept, reject, reprocess | optimistic conflict surface or localized flash |
| Affiliate payouts | preview, confirm | structured payout mapping from the companion payout spec |
| Affiliate links | create, update, delete | optimistic conflict surface or localized flash |
| Affiliate directory | invite/synchronize, edit commission | inline dialog error plus conflict surface where applicable |
| Affiliate Deal attribution widget | assign/change/remove attribution | inline or localized flash plus conflict surface |
| Affiliate portal profile | save payout profile | inline/flash plus conflict surface |
| Intermediary directory | invite, edit, resend/retry, cancel, deactivate, reactivate | dialog/row localized flash plus conflict surface |
| Intermediary Deal assignment widget | assign, reassign, unassign | localized flash plus conflict surface |
| Intermediary portal Deal detail | change partner status, create/update/delete note or activity where exposed | inline/flash plus conflict surface |
| Intermediary bulk assignment | preflight and submit | inline page error or failed progress job from the companion bulk spec |

Read-only loads are not mutations; they keep their existing `ErrorMessage`, page error, or empty-state behavior. CLI, workers, subscribers, setup, redirects, and integration-test cleanup catches are not user UI and are outside this presentation audit.

## Error Presentation Contract

1. A user-triggered mutation handler must `await` the operation inside a `try/catch` or return a DataTable bulk result that DataTable renders.
2. Optimistic 409s first call `surfaceRecordConflict(error, t)`; if it returns false, the handler shows its localized operation fallback.
3. Structured domain errors with safe codes are mapped to localized action-specific messages. Unknown details are not echoed to the user.
4. Dialog mutations keep the dialog open and show an inline error or flash; busy state is cleared in `finally`.
5. A queued mutation returns a progress job ID. Queue/worker failure is visible in the progress UI and must not be replaced with a false success flash.
6. Cancellation by the user is not rendered as an error.
7. Every fallback string lives in the touched module's locale files. No raw server stack, exception object, secret, bank data, name/email beyond the already authorized surface, or provider response is shown.

## Architecture and Scope

- Reuse `readApiResultOrThrow`, `useGuardedMutation`, `surfaceRecordConflict`, `flash`, `Alert`, and `ErrorMessage`.
- Add a tiny module-local error-code mapper only when two or more handlers share the same safe domain codes; otherwise keep the mapping local to the component.
- Do not add a global error provider, platform-wide interceptor, toast abstraction, production dependency, event, route, entity, migration, or public API.
- Do not refactor successful control flow or adjacent component structure.
- Payout-specific structured content and bulk-assignment progress behavior remain authoritative in their companion specifications.

## UI and Accessibility

- Inline errors use semantic `Alert`/`ErrorMessage` and remain associated with the active dialog or form.
- Flashes use existing status variants and localized action names.
- Buttons restore enabled state after failure and keep keyboard retry possible.
- Retry buttons invoke the existing guarded mutation retry only when that surface already exposes it; this audit does not add speculative retry loops.
- No hard-coded colors, arbitrary values, or English-only user strings.

## Backward Compatibility

- No endpoint, request, response, command, event, entity, ACL, or widget spot changes.
- Successful actions and redirects remain unchanged.
- Existing structured conflict behavior is preserved and made consistently reachable.
- The change is private FINOO UI only and does not alter shared `DataTable` or error utilities.

## Testing Strategy

### Static contract audit

A focused test enumerates the in-scope client files and prevents a user-triggered `runMutation`/write handler from having an empty catch or an unhandled promise path. The test is bounded to the two FINOO modules and excludes read-only effects, server/worker files, tests, and cleanup code.

### Component tests

- Each action family listed above has at least one rejected-request test proving a visible localized error or conflict surface.
- Dialog tests prove the dialog remains open and busy state clears.
- DataTable bulk tests prove `{ ok: false, message }` becomes visible and no false success is returned.
- Payout and bulk-assignment specialized tests stay in their companion specifications and satisfy their rows in the inventory.

### Runtime QA

Exercise one representative failure for every action family using safe validation/conflict failures rather than production-destructive faults. Capture the visible UI result and confirm no action appears to succeed silently.

## Risks & Impact Review

### Double error messages

Risk: a guarded mutation and local catch both show an error.

Mitigation: conflict handling is boolean-gated; each handler has one owner for the generic fallback.

### Leaking server details

Risk: displaying `error.message` exposes internal or sensitive content.

Mitigation: only allowlisted safe codes get detailed mappings; unknown failures use localized operation fallbacks.

### Scope expansion

Risk: a local audit turns into a shared-platform error refactor.

Mitigation: shared packages and unrelated modules are explicit non-goals; changes remain in the two private module clients and locale/tests.

## Final Compliance Report

- One independently deployable presentation capability under THOM-103.
- Private FINOO client changes only; no migration, dependency, shared-platform refactor, or upstream PR.
- Completion requires the bounded static audit, focused component tests, typecheck/lint, headed QA, and fresh primary review together with the rest of THOM-103.

## Open Questions

None.

## Changelog

### 2026-08-18

- Split the approved cross-module visible-error audit from payout behavior after fresh scope-cohesion review.
