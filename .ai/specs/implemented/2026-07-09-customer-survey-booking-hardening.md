# Customer Survey Booking Hardening

**Scope:** EPC application module with an additive reusable staff DI contract
**Status:** Implemented and deployed
**Decision date:** 2026-07-09
**Implementation evidence date:** 2026-07-10
**Deployed commit:** `88d292837308ac61f0b482d1f61be9a779c106f9`
**Deployment workflow:** EPC preview run `29056356651` completed successfully

## TLDR

Harden the existing customer portal survey booking flow so that appointment
slots are offered only for active users with the configured Surveyor auth role
and explicit planner availability. A Surveyor without configured availability
produces no slots. Existing calendar interactions continue to remove busy
times, and booking creates or reschedules one canonical planned customer
interaction.

The EPC application must stop reading staff-owned tables directly. The staff
module will expose a narrow DI directory contract for resolving active staff
member scheduling references by user ID. The customer booking implementation
will combine that contract with auth-role membership and the existing planner
availability service.

The implementation includes self-contained API integration coverage for
authorization, role filtering, availability, conflict handling, and create and
reschedule persistence. Deployment, headed portal and backoffice verification,
and Jira evidence read-back all completed successfully.

## 1. Problem Statement

The deployed survey booking flow required implementation and regression
hardening in four areas:

1. When a Surveyor has no planner availability, the code synthesizes weekday
   09:00-17:00 windows. Those slots are not derived from the user's calendar.
2. The EPC module reads `staff_team_members` and `staff_team_roles` directly.
   These are internal tables of an optional module and are not a stable
   cross-module contract.
3. Unit tests cover slot arithmetic but do not exercise customer auth, route
   guards, cross-customer scoping, role filtering, or persistence read-back.
4. Delivery evidence needed to prove that the resulting event is visible on a
   backoffice calendar and deal activity surface, rather than only in the
   portal and canonical API record.

## 2. Goals

- Offer slots only for active users with the configured Surveyor auth role.
- Require explicit planner availability for every offered slot.
- Remove times occupied by non-canceled calendar interactions owned by or
  involving the Surveyor.
- Create or update exactly one planned survey interaction per eligible deal.
- Preserve customer, tenant, and organization isolation.
- Replace direct staff-table access with a documented public DI contract.
- Add deterministic, self-contained integration coverage and cleanup.
- Verify both customer portal behavior and backoffice event visibility.

## 3. Non-Goals

- General-purpose appointment types or configurable booking products.
- External Google or Outlook calendar synchronization.
- Changes to the customer portal authentication model.
- New database tables or migrations.
- Making the EPC Survey stage or portal copy generic in this change.

## 4. Product Decisions

### 4.1 Strict availability

The selected behavior is:

> No configured planner availability means no customer-bookable slots.

There is no default weekday or business-hours fallback. This is fail-closed:
the system must not promise a time the Surveyor did not explicitly expose.

### 4.2 Role source

Surveyor eligibility is based on the tenant-scoped auth role whose name is
configured by `EPC_SURVEYOR_ROLE_NAME` and defaults to `Surveyor`. Staff team
role names do not independently grant customer-bookable eligibility.

An eligible user must also have an active staff member record so planner
subjects can be resolved. Auth-role users without an active staff record or
without availability produce no slots.

### 4.3 Calendar event

Booking creates or reschedules one `CustomerInteraction` with:

- `interactionType = event`
- `status = planned`
- the selected Surveyor as owner, author, and accepted participant
- customer entity and deal links
- configured duration and customer-site location
- the stable EPC survey booking source marker

Rescheduling updates the existing interaction in place. It must not create a
second active survey interaction for the same deal.

## 5. Architecture

### 5.1 Public staff directory contract

The staff module registers an additive scoped DI service named
`staffMemberDirectory`. Its public interface is:

```ts
export type StaffMemberSchedulingRef = {
  userId: string
  staffMemberId: string
  availabilityRuleSetId: string | null
  displayName: string
}

export interface StaffMemberDirectory {
  listActiveSchedulingRefs(params: {
    userIds: string[]
    tenantId: string
    organizationId: string
  }): Promise<StaffMemberSchedulingRef[]>
}
```

`DefaultStaffMemberDirectory` owns all reads of `StaffTeamMember`, maps the
results to the public reference type, and applies requested-user, tenant,
organization, active, and soft-delete constraints. Its Awilix factory accepts
an explicit `em: EntityManager` argument so it works with the application's
`InjectionMode.CLASSIC` container. A regression test resolves the real CLASSIC
container and verifies that the registered entity manager reaches the query.

Consumers resolve the service with `allowUnregistered: true`, because staff is
optional. The EPC implementation passes role-derived user IDs plus the current
tenant and organization scope, then joins the returned references to decrypted
auth users in memory.

The service is a backward-compatibility surface. It must be documented in
`packages/core/src/modules/staff/AGENTS.md` and cannot later be renamed or
removed without the repository deprecation protocol.

### 5.2 EPC composition

The EPC booking service performs these steps:

1. Resolve the authenticated customer's linked people/companies and eligible
   open deals in the configured Survey stage.
2. Resolve user IDs assigned to the configured auth role within tenant and
   organization scope.
3. Resolve `staffMemberDirectory` softly and request active scheduling refs
   for those user IDs.
4. Load planner availability rules for each staff member ID and optional rule
   set ID.
5. Soft-resolve `plannerAvailabilityService` and use it to merge explicit
   availability and unavailability into windows. Empty rules or an unavailable
   planner service result in an empty window list; there is no weekday or
   business-hours fallback.
6. Load busy `CustomerInteraction` intervals and subtract them when building
   slots.
7. Return anonymized slot IDs. Surveyor IDs and private calendar details are
   never returned to the portal.
8. On POST, recompute state and busy intervals before writing, then create or
   update the interaction through the customer interaction command bus.

### 5.3 Module boundaries

The EPC module may use public auth, customers, planner, and customer-accounts
surfaces. It must not import staff entities or issue SQL against staff tables.
The staff directory is the only staff data dependency introduced here.

## 6. API Contract

The existing route remains additive and backward-compatible:

```text
GET  /api/epc/portal/survey-booking
POST /api/epc/portal/survey-booking
```

No request or response fields are removed. The observable change is that
`slots` is empty and `reason` is `no_slots` when no eligible Surveyor has
explicit planner availability.

The route keeps these status contracts:

- `400` invalid body
- `401` missing customer authentication
- `403` missing portal feature
- `404` deal is not visible or eligible for the authenticated customer
- `409` selected slot or Surveyor is no longer available

## 7. UI/UX

- The customer portal widget remains hidden by its portal feature gate.
- Survey-stage customers with availability can book or change an appointment.
- Customers with eligible deals but no explicit Surveyor availability see the
  existing no-slots empty state and cannot submit.
- The booked state survives reload and keeps the existing responsive layout.
- Backoffice deal activity and global calendar visibility of the created event
  were verified in headed QA.

## 8. Persistence Test Matrix

| Field or association | Create read-back | Reschedule read-back | Omitted/retained behavior |
| --- | --- | --- | --- |
| interaction ID | New stable ID returned and readable | Same ID retained | Required |
| tenant ID | Matches portal auth scope | Unchanged | Required |
| organization ID | Matches portal auth scope | Unchanged | Required |
| customer entity ID | Matches owned customer/person | Unchanged | Required |
| deal ID | Matches eligible Survey deal | Unchanged | Required |
| interaction type | `event` | `event` | Retained |
| title/body | Contains survey marker and customer context | Retained or regenerated consistently | Retained |
| status | `planned` | `planned` | Retained |
| scheduled time | Matches selected slot | Matches new selected slot | Updated |
| duration | Matches configured survey duration | Same duration | Retained |
| owner/author | Eligible Surveyor user | Matches newly selected slot owner | Updated if slot owner changes |
| participants | Selected Surveyor accepted | Matches current owner | Updated |
| source | Stable survey source | Unchanged | Retained |
| location | `Customer site` | Unchanged | Retained |
| linked entities | Contains the deal | Unchanged | Retained |
| guest permissions | All disabled | Unchanged | Retained |
| visibility/reminder | Team / configured reminder | Unchanged | Retained |

Every meaningful field sent to the command must be asserted after canonical
API read-back. Mutation status alone is not accepted as persistence proof.

## 9. Automated Test Coverage

### 9.1 Unit tests

- Empty availability produces no slots.
- Explicit windows produce only contained slots.
- Busy interactions remove overlapping slots and preserve exact boundaries.
- Slot IDs remain opaque and stable.
- Duplicate customer-facing times are deduplicated.

Each behavior change follows red-green-refactor: the failing assertion is run
before production code changes.

### 9.2 Integration test

Add a Playwright API integration spec under:

```text
apps/mercato/src/modules/epc_demo/__integration__/
```

The test creates all fixtures through supported APIs or module helpers and
cleans them in `finally`:

- tenant-scoped Surveyor auth role
- Surveyor and non-Surveyor users
- active staff records and explicit planner availability
- two portal customers and their linked deals
- Survey and non-Survey pipeline stages/deals

The test must prove:

1. Anonymous GET returns `401`.
2. Missing portal feature returns `403`.
3. Unlinked customer receives no eligible deals.
4. Customer A cannot see or book Customer B's deal.
5. A non-Survey deal is not eligible.
6. A user without the Surveyor role contributes no slots.
7. A Surveyor without explicit availability contributes no slots.
8. Slots stay inside configured availability.
9. A busy event removes its overlapping slot.
10. POST creates one interaction and passes the create persistence matrix.
11. Reusing the occupied slot for another deal returns `409`.
12. POST with another available slot updates the same interaction and passes
    the reschedule persistence matrix.
13. Portal GET reloads into the booked state.

## 10. Manual Verification

Completed headed browser QA covered:

- customer portal desktop booking, reload persistence, and rescheduling;
- mobile booked state and slot modal at 390px without horizontal overflow;
- no-slots state for a Surveyor without explicit availability;
- stale-slot `409` handling with a visible non-destructive conflict message;
- backoffice deal activity, mini-calendar, and global calendar event
  visibility; and
- final canonical interaction read-back after cleanup of the temporary stale
  slot busy event.

All accepted screenshots were semantically inspected, inventoried, uploaded to
Jira THOM-64, and read back from the attachment section before the issue was
marked Done.

## 11. Backward Compatibility

- Existing route paths and payload shapes are unchanged.
- The new staff DI key and result fields are additive.
- The strict availability behavior intentionally removes synthetic slots that
  were never backed by configured availability.
- No schema or migration change is required.
- The staff DI contract follows the repository deprecation policy for future
  changes.

## 12. Alternatives Considered

### Keep the 09:00-17:00 fallback

Rejected because it can offer appointments without explicit Surveyor consent
or calendar configuration.

### Infer availability only from gaps between busy events

Rejected because an empty calendar does not define working hours.

### Keep direct SQL in the EPC module

Rejected because staff is optional and its tables are explicitly internal.
Direct SQL would make the EPC feature depend on an unstable schema.

### Build a generic upstream appointment-booking framework now

Deferred. The current product still depends on EPC-specific stage, copy, and
workflow semantics. The additive staff directory contract may be assessed
separately for upstream contribution after EPC delivery and verification.

## 13. Risks and Mitigations

| Risk | Severity | Mitigation | Residual risk |
| --- | --- | --- | --- |
| Existing Surveyors have no availability and lose all slots | Medium | Fail closed by design; expose clear no-slots state and configure availability before release | Operational setup is required |
| Cross-customer data exposure | High | Scope every lookup by auth tenant/org and customer ownership; integration-test Customer A/B | Low |
| Double booking under concurrent requests | High | Recompute slot and busy state immediately before command write; test `409` | A database-level exclusion constraint is outside scope |
| Staff module absent | Medium | Soft-resolve the public directory and return no slots | Booking unavailable until staff is enabled |
| Public DI contract later changes | Medium | Document as stable BC surface | Maintainers must follow deprecation policy |

## 14. Success Criteria

- No generated slot exists outside explicit Surveyor planner availability.
- No non-Surveyor or cross-customer deal can be booked.
- Create and reschedule read back every field in the persistence matrix.
- Reschedule retains the original interaction ID.
- The booked event is visible in the portal, deal activity, and global
  backoffice calendar.
- Unit, integration, typecheck, lint, generate, and relevant build checks
  passed.
- Deployed headed QA evidence is attached and verified.

## 15. Implementation Status and Compliance

Implementation, deployment, headed browser QA, and durable Jira evidence are
complete. The following compliance record includes the focused implementation
checks and the final delivery evidence.

| Criterion | Implementation and automated evidence | Status |
| --- | --- | --- |
| Stable staff scheduling boundary | `packages/core/src/modules/staff/services/staffMemberDirectory.ts` defines `StaffMemberDirectory` and `StaffMemberSchedulingRef`; `packages/core/src/modules/staff/di.ts` registers scoped `staffMemberDirectory`. The directory query is tenant- and organization-scoped, active-only, non-deleted, ordered deterministically, and returns no rows for no requested users. | Passing focused tests |
| CLASSIC DI compatibility | `packages/core/src/modules/staff/__tests__/di.test.ts` creates a real CLASSIC container, resolves the directory through the public key, verifies the registered entity manager reaches the query boundary, and covers scoped lifetime. | Passing focused tests |
| Role-based and fail-closed slot eligibility | `apps/mercato/src/modules/epc_demo/lib/surveyBooking.ts` derives candidates from the configured tenant-scoped Surveyor auth role, softly resolves `staffMemberDirectory`, and requires an active scheduling reference. `resolveSurveyorAvailabilityWindows` returns no windows when rules are empty or the planner service is unavailable; synthetic working-hour fallback and direct staff-table access are removed. | Passing focused tests and forbidden-pattern check |
| Booking and conflict behavior | The booking path recomputes candidate and busy state with the request container before writing. It creates or updates one planned survey `CustomerInteraction`; a stale or occupied slot returns `409`, and rescheduling keeps the interaction ID while updating schedule, owner, author, accepted participant, and `updatedAt`. | Passing focused API integration |
| Authorization, isolation, and persistence | `apps/mercato/src/modules/epc_demo/__integration__/TC-EPC-SURVEY-001.spec.ts` is self-contained and cleans up its fixtures. It covers anonymous `401`, missing feature `403`, unlinked and cross-customer isolation, non-Survey deals, non-Surveyor and no-availability exclusion, owner- and participant-only busy intervals, create read-back, same-slot `409`, cross-Surveyor reschedule read-back, and portal reload. Canonical read-back asserts scalar fields, participants, links, guest permissions, tenant, organization, and `updatedAt`. | Passing focused API integration |
| Focused local verification | Task 5 passed `corepack yarn generate`; staff DI tests (2 suites, 5 tests); survey booking tests (1 suite, 9 tests); core, app, and root `corepack yarn typecheck` (23/23 tasks); `corepack yarn lint` (exit 0; 16 inherited warnings); `corepack yarn build:packages` (23/23 tasks); and `corepack yarn build:app` (1/1 task). The scoped Prettier check also passed. | Passed |
| Managed integration verification | The managed ephemeral stack initialized successfully, including migrations, generation, package builds, and production application build. `BASE_URL=<managed-ephemeral-base-url> corepack yarn exec playwright test --config .ai/qa/tests/playwright.config.ts apps/mercato/src/modules/epc_demo/__integration__/TC-EPC-SURVEY-001.spec.ts --workers=1 --retries=0` passed: 1 test passed with fixture cleanup. | Passed |
| Deployment, headed portal QA, and backoffice visibility | `fork/EPC@88d292837308ac61f0b482d1f61be9a779c106f9` deployed through EPC workflow run `29056356651`, completed successfully. Headed agent-browser QA passed explicit availability, no-slots, create, reload persistence, reschedule, 390px mobile layout, stale-slot `409`, deal activity, and global calendar. The final interaction `2ce041a1-6675-4845-9098-bbc0397dc2b8` is planned for `2026-07-10T12:00:00Z`, 60 minutes, with the Surveyor as owner, author, and sole participant, linked to the Survey deal. | Passed; Jira THOM-64 Done |

The forbidden-pattern check
`rg -n "staff_team_members|staff_team_roles|buildFallbackWorkingWindows" apps/mercato/src/modules/epc_demo`
returned no matches (exit code 1 is expected for an empty `rg` result).

### Accepted Headed QA Artifacts

The following ten semantically accepted screenshots were uploaded to Jira
THOM-64 and every filename was read back from the attachment section:

- `01-portal-no-slots-desktop.png`
- `02-portal-explicit-slots-desktop.png`
- `11-portal-ready-to-book-desktop.png`
- `12-portal-fresh-booking-confirmation.png`
- `17-portal-final-reschedule-cdp.png`
- `18-backoffice-final-event-14.png`
- `19-portal-stale-slot-conflict.png`
- `20-backoffice-final-global-calendar-14.png`
- `21-portal-final-mobile-390.png`
- `22-portal-final-mobile-slots.png`

The evidence inventory recorded authenticated, complete, readable states for
each artifact. Jira showed all ten attachments after upload, the
post-deployment QA comment was saved and read back, and THOM-64 was read back
in the Done state.

## 16. Changelog

- 2026-07-09: Approved strict-availability design, public staff directory
  boundary, persistence matrix, and verification plan.
- 2026-07-10: Recorded implementation completion: the additive
  `staffMemberDirectory` DI boundary, CLASSIC-container regression coverage,
  strict fail-closed Surveyor availability, role-based lookup, and focused
  booking create/reschedule/conflict integration evidence.
- 2026-07-10: Finalized deployed verification for
  `88d292837308ac61f0b482d1f61be9a779c106f9`: EPC workflow run `29056356651`
  succeeded; headed portal and backoffice QA passed; ten accepted screenshots
  and the QA comment were read back from Jira THOM-64; the issue was marked
  Done.
