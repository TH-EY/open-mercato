# Customer Survey Booking Hardening

**Scope:** EPC application module with an additive reusable staff DI contract
**Status:** Approved design; implementation pending
**Decision date:** 2026-07-09

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

The change includes self-contained integration coverage for authorization,
role filtering, availability, conflict handling, create and reschedule
persistence, and backoffice visibility.

## 1. Problem Statement

The deployed survey booking flow works end to end, but its implementation and
regression coverage have four gaps:

1. When a Surveyor has no planner availability, the code synthesizes weekday
   09:00-17:00 windows. Those slots are not derived from the user's calendar.
2. The EPC module reads `staff_team_members` and `staff_team_roles` directly.
   These are internal tables of an optional module and are not a stable
   cross-module contract.
3. Unit tests cover slot arithmetic but do not exercise customer auth, route
   guards, cross-customer scoping, role filtering, or persistence read-back.
4. Deployed QA proves the portal flow and canonical API record, but does not
   prove that the resulting event is visible on a backoffice calendar or deal
   activity surface.

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

The staff module will register an additive DI service named
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

The staff implementation owns all reads of `StaffTeamMember`. It applies
tenant, organization, active, and soft-delete constraints. Consumers resolve
the service with `allowUnregistered: true`, because staff is optional.

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
5. Use `plannerAvailabilityService` to merge explicit availability and
   unavailability into windows. Empty rules or an unavailable planner service
   result in an empty window list.
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
- The backoffice deal activity or calendar surface shows the created event
  with its Surveyor owner and scheduled duration.

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

After deployment, headed browser QA must cover:

- customer portal desktop booking and rescheduling
- mobile booked state without horizontal overflow
- no-slots state for a Surveyor without availability
- backoffice deal activity or calendar event visibility
- reload persistence on both customer and backoffice surfaces

Every screenshot or recording must be semantically inspected, inventoried,
uploaded to the internal issue, and read back before completion.

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
- The booked event is visible in the portal and backoffice calendar/activity.
- Unit, integration, typecheck, lint, generate, and relevant build checks pass.
- Deployed headed QA evidence is attached and verified.

## 15. Changelog

- 2026-07-09: Approved strict-availability design, public staff directory
  boundary, persistence matrix, and verification plan.
