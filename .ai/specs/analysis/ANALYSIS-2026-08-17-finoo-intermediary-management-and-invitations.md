# Pre-Implementation Analysis: FINOO Intermediary Management and Invitations

## Executive Summary

The specification is cohesive and additive, and no backward-compatibility break is required. The codebase-backed gaps found during the first pass have been corrected in the specification: email search is exact/hash-only while names remain partially searchable, the required `search.ts` surface is present in the file and verification manifests, and invite/edit dialogs use embedded `CrudForm` while row lifecycle actions use `useGuardedMutation`. The design is ready to implement after the task-bound THOM-100 branch and authoritative baseline are freshly read back.

## Backward Compatibility

### Violations Found

No required breaking change was found. The audit covered all 14 categories in the current `BACKWARD_COMPATIBILITY.md` (the pre-implementation skill still refers to 13): auto-discovery, exported types, function signatures, import paths, event IDs, widget spots, API routes, database schema, DI keys, ACL IDs, notification IDs, AI/override IDs, CLI commands, and generated files.

| Surface | Current contract | Required preservation |
|---------|------------------|-----------------------|
| Auto-discovery | Existing `index.ts`, `acl.ts`, `setup.ts`, `cli.ts`, `encryption.ts`, entities, routes, and widget table | Add `events.ts`, `search.ts`, subscribers, routes, page, and entity without renaming current exports. |
| Types and schema | Assignment/note entities, `PartnerStatus`, and strict schemas | Add separate directory types/schemas; do not repurpose existing fields. |
| Function signatures | `CustomerInvitationService.createInvitation(email, scope, options)` flushes its constructor EM; `revokeAllUserSessions(userId, em?)` already supports a caller EM | Add only an optional transactional EM parameter or additive method; preserve the existing call signature and return shape. |
| Imports | Existing stable Customer Accounts and Customers package paths | Reuse current paths; no Sales dependency and no moved public helper. |
| Events | Frozen `customer_accounts.invitation.accepted` currently emits `invitationId`, `userId`, and `tenantId` | Consume the existing event. Reload the invitation and revalidate organization/user scope; do not assume `organizationId` is in the payload. |
| Widget spots | `detail:customers.deal:tabs` and widget ID `finoo_intermediaries.injection.deal-assignment` | Preserve spot, widget ID, and `dealId` meaning. |
| API | Existing picker URL, `query`, `pageSize`, `{ items }`, and `id = customerUserId` | Keep wire shape and meanings. Apply the Active-directory predicate in both picker and direct assignment authorization. |
| Database | Assignment and note tables/columns/indexes | Add the directory table only; retain scalar Customer Accounts IDs and every existing table/column/index. |
| DI | Existing Customer Accounts service names; no FINOO DI registrar | Resolve existing names unchanged; a FINOO DI layer is not required. |
| ACL | Frozen `finoo_intermediaries.view`, `.manage`, and `portal.finoo_intermediaries.view` | Reuse IDs and current default grants. |
| Notifications | No FINOO notification type | Do not add or repurpose one incidentally. |
| AI/override IDs | No affected surface | No change. |
| CLI | Existing `ensure-portal-role-feature` command and required flags | Add a separate backfill command and prove both are generated/registered. |
| Generated files | Existing entity, API, widget, and command IDs | Regenerate additively; never hand-edit or lose existing entries. |

### Missing BC Section

None. The specification includes `Migration and Backward Compatibility` and correctly preserves existing assignments, portal routes, ACLs, widget IDs, picker field meanings, and generated contracts.

## Spec Completeness

### Missing Sections

None of the required top-level sections is absent.

### Incomplete Sections

| Section | Gap | Recommendation |
|---------|-----|----------------|
| Encryption and search | Partial email search conflicts with mandatory PII `hashOnly` policy. | Make first/last name searchable and email exact-match only through its lookup hash; exclude identity fields from vector source text. |
| File Manifest | Required module `search.ts` is absent. | Add `apps/mercato/src/modules/finoo_intermediaries/search.ts` and its focused tests. |
| Verification Commands | Search package checks and generated CLI registration are not named. | Add focused search tests and assertions that both old and new FINOO CLI commands remain generated. |
| Frontend Architecture Contract | Controlled invite/edit dialog wording does not require the canonical form host. | Specify embedded `CrudForm` for invite/edit; reserve `useGuardedMutation` for resend/retry/cancel/deactivate/reactivate row actions. |
| Invitation acceptance subscriber | The existing event does not contain `organizationId`. | Require reload by trusted `invitationId + tenantId`, then verify invitation, user, and directory organization equality under lock. |
| Navigation | The page route is specified, but its staff navigation placement is not. | Add a stable main Customers-group navigation entry named Intermediaries, gated by `finoo_intermediaries.view`. |
| Rollout ordering | Tightening the picker before backfill would hide existing valid users. | Require schema/candidate availability, scoped dry-run/apply and zero-change second run before cutover exposes the stricter picker. |

## AGENTS.md Compliance

### Violations

| Rule | Location | Fix |
|------|----------|-----|
| PII fields such as email must use `fieldPolicy.hashOnly`; encrypted/sensitive fields must not enter vector source text. | `Encryption and search` | Exact email matching only; names may use canonical text search; no identity vector source. |
| Every searchable entity must declare module `search.ts`. | File Manifest | Add the missing convention file and generator/search verification. |
| Backend create/edit and dialog forms use `CrudForm`. | Frontend Architecture Contract and UI/UX | Use embedded `CrudForm` for Invite and Edit; keep action endpoints guarded with `useGuardedMutation`. |

The canonical review checklist is `.ai/review-checklist.md`; the path named by the skill (`.agents/skills/om-code-review/references/review-checklist.md`) does not exist in this checkout.

## Risk Assessment

### High Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Cross-tenant or cross-organization identity mutation | PII disclosure or unauthorized account/role/session change | Central scoped lookup helper, email hash candidates, generic foreign conflicts, row locks, and forged-ID integration matrix. |
| Whole-account deactivate/reactivate | Stops or restores access from unrelated preserved portal roles | Explicit warnings, Customer Accounts manage ACL, atomic user/role/session/directory change, cache invalidation after commit, and multi-role tests. |
| Token/delivery/acceptance race | Stale token remains valid or stale send result overwrites newer state | Rotate/cancel under lock, compare-and-set delivery result, persistent idempotent subscriber, attempt every superseded token. |
| Picker/backfill ordering | Existing intermediary users disappear from Deal assignment | Backfill before cutover to active-only picker; assert direct assignment and picker share one predicate. |
| Transaction boundary in invitation service | Partial directory/invitation commit | Add a backward-compatible caller-EM seam and prove rollback/atomicity with focused core tests. |

### Medium Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Related Deals N+1 | Directory latency grows with row count | One grouped count query per page and a query-count unit/integration assertion. |
| Search index lag or unavailable fulltext backend | A new/edited name may be temporarily absent | Canonical DB read-back remains authoritative; token strategy and exact email hash provide bounded fallback behavior. |
| Backfill name ambiguity | Incorrect staff-visible names | Dry-run fails without writes when two non-empty names cannot be produced; deterministic fallback and later Admin edit. |
| Synchronous provider failure | Invitation not delivered | Durable Delivery failed state, Retry action, sanitized error code, and controlled captured/live email proof. |

### Low Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Additional generated registry entries | Stale local navigation/routes | Run generation plus structural cache invalidation; inspect additive registry output. |
| New staff page responsive layout | Narrow viewport friction | Shared Page/DataTable/Dialog primitives plus desktop and narrow headed QA. |

## Gap Analysis

### Critical Gaps (Resolved)

- Search privacy contract corrected to partial name search plus exact hash-only email matching.
- Canonical form contract corrected to require embedded `CrudForm` for Invite and Edit dialogs.

### Important Gaps (Resolved in the Specification)

- Add `search.ts` to the file manifest and validation plan.
- Define trusted organization recovery/revalidation in the acceptance subscriber.
- Freeze current picker request/response behavior with a compatibility test before tightening it.
- Tighten both picker and direct assignment authorization through one Active-directory predicate.
- Preserve and verify the existing FINOO CLI command when adding backfill.
- State staff sidebar placement and deployment ordering explicitly.

### Nice-to-Have Gaps

- None required for the approved scope.

## Remediation Plan

### Before Implementation (Must Do)

1. Update the spec with exact-email/hash-only search, name search, and no identity vector source.
2. Add `search.ts`, search tests, canonical embedded `CrudForm`, acceptance revalidation, navigation placement, and cutover ordering to the spec.
3. Bind the current isolated checkout to THOM-100 and re-read the freshly fetched authoritative `origin/fork/finoo` head.
4. Add characterization tests for picker wire compatibility, shared picker/assignment eligibility, invitation service signature/return, and existing CLI registration.

### During Implementation (Add to Spec)

1. Keep the implementation changelog and file manifest synchronized with the actual minimal files.
2. Record the exact additive transactional seam selected for Customer Invitation creation.
3. Maintain a field-persistence matrix for first name, last name, email, lifecycle state, linked IDs, delivery metadata, and optimistic version.

### Post-Implementation (Follow Up)

1. Run fresh-db initialization, focused unit/integration gates, client boundary check, app build, and diff checks.
2. Obtain one fresh primary review and one security review before any FINOO build/deploy.
3. Deploy only after backfill dry-run/apply ordering is proven; complete headed desktop+narrow QA, durable Jira evidence, and release-evidence review.

## Recommendation

**Ready to implement after the task-bound branch/baseline read-back.** No product clarification is required because the corrections preserve the approved user behavior while applying mandatory privacy, form, and compatibility contracts.
