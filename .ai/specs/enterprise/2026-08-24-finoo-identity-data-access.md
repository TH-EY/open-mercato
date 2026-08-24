# FINOO Identity Data Access

## TLDR

**Key points:**

- FINOO moves PESEL and identity-document values out of broadly visible Person custom fields into one private, encrypted, tenant- and organization-scoped module.
- Only holders of immutable `finoo_identities.view` / `finoo_identities.manage` features and platform superadmins may read or edit raw values. Other staff see only safe completeness metadata.
- The module provisions `IOD — Inspektor ochrony danych` with view/manage features but never assigns users automatically.

**Scope:** one current document, PESEL validation, field completeness, audited reads/writes/denials, write-only form ingestion, safe import conflicts, Person UI integration, and an approval-gated migration/purge. This is FINOO-private; no upstream contribution.

**Concern:** permanent removal of legacy values and definitions is irreversible and remains a separate last-responsible-moment approval gate.

## Overview

FINOO currently stores PESEL and identity-document data as custom fields on `customers:customer_person_profile`. Ordinary Person access can therefore expose these fields through standard APIs and UI surfaces. This feature establishes a dedicated security boundary while retaining neutral operational visibility into whether each field is complete.

Target actors are IOD users, platform superadmins, ordinary FINOO staff, and the trusted FINOO application projector. Only the first two can read values. Ordinary staff see statuses only. The projector can create through a write-only service and never receives stored values.

### Research basis

- **Documented design:** OWASP recommends deny-by-default, least privilege, per-request authorization, access-control logging, and tests: [Authorization Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html).
- **Documented design:** high-risk access and authorization failures should record actor, target, time, action, and outcome while excluding government identifiers and sensitive values: [Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html).
- **Documented design:** only necessary data should be exposed and accessibility should be restricted by default: [European Commission GDPR principles](https://commission.europa.eu/law/law-topic/data-protection/rules-business-and-organisations/principles-gdpr/overview-principles/what-data-can-we-process-and-under-which-conditions_en), [European Commission obligations](https://commission.europa.eu/law/law-topic/data-protection/information-business-and-organisations/obligations_en), and [EDPB Guidelines 4/2019](https://www.edpb.europa.eu/documents/guideline/guidelines-42019-on-article-25-data-protection-by-design-and-by-default_en).

This specification is a technical design, not legal advice.

## Problem Statement

1. Raw values use a Person custom-field boundary rather than identity-specific authorization.
2. Ordinary staff need missing-field visibility without values, masks, lengths, invalidity hints, or other side channels.
3. `finoo_applications` writes raw identity fields into customer custom fields and may update them on later submissions.
4. Reads, changes, and denials need a durable value-free audit; the shared non-core access log rotates too quickly.
5. Legacy data needs a lossless, idempotent, value-free migration report, rollback window, and separately approved purge.

## Proposed Solution

Add the FINOO-private app module `finoo_identities`. It owns encrypted identity records, temporary encrypted import conflicts, append-only value-free audits, validation/completeness logic, authorization, APIs, widgets, response enrichment, list filtering, setup, and migration commands.

### Design decisions

| Decision | Rationale |
|---|---|
| Module ID `finoo_identities` | Matches plural repository naming and feature IDs. |
| One active record per Person | One current document was explicitly confirmed. |
| PESEL is the sole identity identifier | Foreign identifiers were removed from scope. |
| Explicit service authorization after `requireAuth` on raw routes | Dispatcher feature denial happens before module code and cannot create the required Person/org-specific denial audit. |
| Server-computed `is_complete` projection | Enables an indexed safe filter without decrypting values for ordinary users. |
| DI-resolved write-only projector service | Avoids cross-module ORM coupling and returns only `created`, `unchanged`, or `conflict`. |
| Temporary encrypted conflict | Existing data is never overwritten without IOD/superadmin review; candidate values are cleared at closure. |
| Dedicated audit entity | Shared non-core access-log retention is insufficient and has no Person-erasure anonymization. |
| Deactivate definitions before later purge | Closes generic surfaces while retaining a short rollback source. |

### Alternatives considered

| Alternative | Why rejected |
|---|---|
| UI-only hiding | Does not protect APIs, imports, exports, search, or alternate paths. |
| Existing encrypted custom fields | Encryption protects storage, not post-decryption authorization. |
| Mutable role-name checks | Repository policy requires immutable feature IDs. |
| Write-only ordinary users | Explicitly rejected. |
| Masks or validation hints | Explicitly rejected. |
| Shared `audit_logs.access_log` | Short rotation and no confirmed anonymization semantics. |
| Document history | Explicitly out of scope. |

## User Stories / Use Cases

- IOD and superadmin can view and maintain a Person's PESEL and current document.
- Ordinary staff can identify complete/missing fields without learning values.
- Ordinary staff cannot submit values through browser or API.
- The trusted projector creates only when no identity exists and cannot read/overwrite an existing record.
- IOD/superadmin can compare and resolve a safe import conflict.
- Audit establishes actor, subject, scope, time, operation, and outcome without raw values.

## Scope and Boundaries

### In scope

- PESEL, document type, issuing-country code, document number, issue date, conditional expiry date.
- PESEL length, checksum, and encoded-date validation.
- Current form types `identity_card`, `permanent_identity_card`, `passport`, and `digital_identity_card`; expiry applicability derives from module-owned type metadata. The permanent identity-card variant is the non-expiring type and yields `not_applicable` for expiry.
- One active identity and value-cleared closed conflicts per Person.
- List aggregate status/filter and detail status per field: `complete`, `missing`, `not_applicable`.
- Privileged raw-data UI, write-only ingestion, audited access, migration, rollback, and purge tooling.

### Out of scope

- Foreign identifiers, multiple current documents, history, bulk raw export, automatic IOD user assignment, deletion at document expiry, retention scheduler/legal holds/backup expiration, public API, or upstream contribution.

### Retention boundary

The separate retention capability owns one Person-level `retentionExpiresAt`; this module adds no second clock. `anonymizeAndDeleteForPerson({ systemActor: true })` is the retention-owned execution seam. In one transaction it deletes the active identity and conflicts, redacts Person-linked identity keys from encrypted `finoo_application_intakes`, deletes the PESEL binding and any unpurged legacy values, nulls audit `person_id`, and retains only a value-free subject digest. No scheduler is added here; expiry only flags until the external retention owner invokes the separately authorized erasure.

## Authorization Model

| Feature | Grant | Purpose |
|---|---|---|
| `finoo_identities.view` | IOD; superadmin bypass | Raw identity/conflict read and audit read. |
| `finoo_identities.manage` | IOD; superadmin bypass | Create/update and conflict resolution. |

`setup.ts` calls `ensureRoles` for exact role `IOD — Inspektor ochrony danych` and declares:

```ts
defaultRoleFeatures: {
  superadmin: ['finoo_identities.*'],
  'IOD — Inspektor ochrony danych': [
    'customers.people.view',
    'finoo_identities.view',
    'finoo_identities.manage',
  ],
}
```

No `admin`, `employee`, `import`, or automatic `UserRole` grant is added. Existing-tenant rollout runs module defaults and `auth sync-role-acls` after role creation.

| Operation | IOD | Superadmin | Ordinary staff | Projector |
|---|---:|---:|---:|---:|
| Aggregate/detail statuses | Yes | Yes | With `customers.people.view` | No need |
| Raw read | Yes | Yes | Denied + audited | Never returned |
| Human create/update | Yes | Yes | Denied + audited | No |
| Create-if-absent | No | Not this path | No | `systemActor` only |
| Import overwrite | Review only | Review only | No | Never |
| Resolve conflict | Yes | Yes | Denied + audited | Status only |

## Architecture

```text
customers Person API/UI
    | safe response enricher + safe filter interceptor
    v
finoo_identities
    IdentityAccessService
    - scoped authorization + allowed/denied audit
    - encrypted read/update
    - completeness + optimistic lock
    ^
    | DI tryResolve('finooIdentityTechnicalImport'), write-only
finoo_applications projector

Person retention erasure -> identity/conflicts/copies removed; audit subject link anonymized
```

### Placement and coupling

- New module: `apps/mercato/src/modules/finoo_identities/`.
- Scalar `personId` only; no ORM relationship to `customers`.
- The identity module owns customer glue through response enrichers, API interceptors, and widget injection.
- `finoo_applications` resolves the narrow `finooIdentityTechnicalImport` DI port with a local structural interface and never imports identity entities. The external Person-retention owner will call the equally narrow `finooIdentityRetention` port; it must not resolve the full identity service.
- Missing identity service fails projection closed with `identity_service_unavailable`; encrypted intake remains retryable and custom fields are not used as fallback.
- Customer widgets declare `requiredModules: ['customers']`.

### Service boundary

`FinooIdentityService` owns every raw operation:

- `readForAuthorizedActor`;
- `readStatusForPersonViewer`;
- `upsertForAuthorizedActor`;
- `createFromTechnicalImport`;
- `listConflictsForAuthorizedActor`;
- `resolveConflictForAuthorizedActor`;
- `anonymizeAndDeleteForPerson`.

No route, widget, enricher, interceptor, report, event, or logger reads raw columns directly outside the service/migration implementation.

### Audited authorization sequence

Raw API metadata uses `requireAuth: true`. The handler resolves scope and calls `authorizeAndAudit`:

1. validate Person UUID and resolved tenant/organization;
2. check immutable features with `rbacService.userHasAllFeatures` (standard superadmin bypass preserved);
3. append actor, Person, scope, operation, and `allowed`/`denied`;
4. return 403 before decrypting on denial;
5. continue on allow.

This documented exception to dispatcher `requireFeatures` is required for subject-specific denial audit. Contract/integration tests enforce the helper on every raw route.

### Mutation side effects and events

Raw identity values stay inside the narrow service transaction and are deliberately not placed in the generic Command Bus input, command interceptors, undo snapshots, or action-log payload. Human routes still run the shared mutation guards, but pass only changed field names after the audited feature check. The service provides the equivalent required side effects directly: optimistic locking, Person-scoped advisory locking, transactional value-free audit, post-commit Person cache invalidation, and typed persistent events. Post-commit effects are best-effort operational signals: failures are logged with value-free metadata and never turn an already committed identity mutation into a false API failure.

Events contain IDs, scope, operation, changed field names, and completeness transition only:

- `finoo_identities.identity.created|updated|erased`;
- `finoo_identities.import_conflict.created|resolved`.

They are excluded from workflow triggers and are not client-broadcast. Event payloads contain no raw values. Audit persistence is transactional with the identity mutation; cache invalidation and persistent event emission run only after a successful commit.

## Data Models

### FinooPersonIdentity

Table `finoo_person_identities`:

| Column | Type | Notes |
|---|---|---|
| `id` | UUID | Primary key. |
| `tenant_id`, `organization_id` | UUID | Required scope. |
| `person_id` | UUID | Scalar cross-module ID. |
| `pesel` | text nullable | Encrypted; null allowed for migrated/internal partial state. |
| `document_type` | text nullable | Encrypted. |
| `issuing_country_code` | text nullable | Encrypted. |
| `document_number` | text nullable | Encrypted. |
| `issued_on`, `expires_on` | text nullable | Encrypted ISO `YYYY-MM-DD`; ciphertext-compatible storage. |
| `is_complete` | boolean | Server-computed safe projection, never accepted from input. |
| `field_statuses` | JSON | Server-computed six-field `complete`/`missing`/`not_applicable` projection; contains no values or validation reasons. |
| `created_at`, `updated_at`, `deleted_at` | timestamps | Optimistic lock/lifecycle. |

Invariants/indexes:

- unique active `(tenant_id, organization_id, person_id)`;
- `(tenant_id, organization_id, is_complete, person_id)`;
- every query includes tenant, organization, and active lifecycle scope;
- aggregate and per-field completeness projections recompute transactionally on every protected-field change.

`encryption.ts` declares all six raw columns in `defaultEncryptionMaps`. Reads use five-argument `findWithDecryption` / `findOneWithDecryption`. No PESEL lookup hash is added; the existing application binding hash remains the idempotency key.

### FinooIdentityImportConflict

Table `finoo_identity_import_conflicts` contains ID/scope/Person, `source_module`, `source_record_id`, keyed `candidate_digest`, the same six encrypted nullable candidate fields, safe `changed_fields`, `state`, timestamps, and `resolved_at`. Open conflicts are unique by scoped source record/digest. Resolve/dismiss nulls all candidate values transactionally and retains safe closure metadata only.

### FinooIdentityAuditEntry

Table `finoo_identity_audit_entries` contains ID/scope, nullable actor user, `actor_kind`, nullable `person_id`, keyed pseudonymous `subject_digest`, operation, allowed/denied outcome, nullable changed field names, and `created_at`.

It has no raw values, snapshots, free text, update endpoint, delete endpoint, or export endpoint. Future Person erasure clears `person_id`; Person name is never stored.

## Validation and Completeness

- PESEL normalizes to exactly 11 digits and validates checksum plus 1800–2299 encoded date.
- New human/import writes reject invalid PESEL. Migration may preserve invalid legacy ciphertext but its status is `missing`; validation detail is visible only in the privileged form.
- Country code normalizes uppercase and matches two ASCII letters.
- Document number is trimmed/bounded; internal formatting is preserved.
- Dates are ISO `YYYY-MM-DD`; required expiry cannot precede issue date.
- Document type is module-catalog metadata; request input cannot set expiry applicability.

| Field | `complete` | `missing` | `not_applicable` |
|---|---|---|---|
| PESEL | Present and valid | Absent/invalid | Never |
| Type | Recognized | Absent/unknown | Never |
| Country | Valid | Absent/invalid | Never |
| Number | Non-empty/valid | Absent/invalid | Never |
| Issue date | Valid | Absent/invalid | Never |
| Expiry date | Valid and ordered when required | Absent/invalid when required | Type metadata says no expiry |

Aggregate completeness is true only when no status is `missing`. Ordinary responses never carry masks, lengths, partial values, or reasons.

## API Contracts

All routes are private, scoped, zod-validated, documented with `openApi`, and return stable error codes/field names only.

### Raw identity

`GET /api/finoo_identities/people/:personId`

- Requires authenticated actor and service-level `finoo_identities.view`.
- `200`: raw fields, statuses, `isComplete`, `updatedAt`.
- `403 identity_access_denied`, `404 identity_not_found`, `422 invalid_scope`.
- Every 200/403 attempt is audited before response.

`PUT /api/finoo_identities/people/:personId`

- Requires `finoo_identities.manage`.
- Request has required valid `pesel`; document fields may remain incomplete.
- Update requires standard optimistic-lock header from `updatedAt`.
- `200` echoes statuses/completeness/version, not raw values.
- Custom-route mutation guards receive safe changed-field/action metadata before the service transaction; cache/event callbacks run after commit.

### Audit and conflicts

`GET /api/finoo_identities/people/:personId/audit?page=1&pageSize=50`

- Requires `view`; `pageSize <= 100`; returns metadata only, newest first; the read is itself audited.

`GET /api/finoo_identities/import-conflicts?personId=:personId&page=1&pageSize=50`

- Requires `view`; returns current/candidate values only to authorized actors plus changed-field names/version.

`POST /api/finoo_identities/import-conflicts/:id/resolve`

- Requires `manage`.
- Request `{ action: 'replace' | 'dismiss', updatedAt, identityUpdatedAt }`.
- Replace validates and atomically updates the one active identity; dismiss keeps it. Both clear candidate values and enforce both optimistic locks.

### Safe Person enrichment

- `GET /api/customers/people` adds `_finooIdentities: { isComplete }`.
- `GET /api/customers/people/:id` adds `_finooIdentities: { isComplete, statuses }`.

The host route supplies normal Person authorization. The enricher has no identity feature, uses one scoped batch query, and never decrypts raw fields.

### Completeness filter

The server filter accepts `finooIdentityComplete=true|false`. A before interceptor queries only scoped Person IDs/safe `is_complete`, treats a missing identity row as incomplete, intersects existing IDs, and forwards them.

Shared CRUD `ids` transport caps at 200. The interceptor must return `422 identity_filter_too_broad` when matches exceed 200; it must never truncate. FINOO currently fits this bound. A future scale task may add a first-class query-engine join.

## UI/UX

### Person list

- Inject localized `Dane tożsamości` into `customers.people.list`.
- Render only `StatusBadge`: complete/incomplete.
- Keep the server filter contract for direct/API consumers. People v2 currently suppresses injected simple filters when its external advanced-filter panel is present; adding a first-class visible control requires an additive platform extension and is tracked outside this FINOO-private module change.
- No raw row/bulk actions.

### Person detail

- Inject one identity section with six status rows for every Person viewer.
- Use semantic success/warning/info states only.
- Raw panel appears only with `view`; edit/conflict controls only with `manage`.
- Raw panel loads through protected API, creating an access audit.
- Use `CrudForm`, shared fields/date/select, `createCrudFormError`, and `apiCall`; Cmd/Ctrl+Enter submits and Escape cancels.
- Use `LoadingMessage`/`ErrorMessage`, localized strings and `aria-label`s; no hardcoded status colors.

### Frontend contract

Client components only render/local-state. Server APIs/service own authorization, decryption, validation, completeness, and conflict decisions. Components never receive raw identity through Person API/server page. No raw value enters URL, filter, analytics, toast, console, or shared cache.

## Internationalization

Add Polish/English keys for module/field/status/filter labels, form actions, conflict UI, errors, optimistic lock, and audit labels. No user-facing strings are hard-coded.

## Migration & Compatibility

### Legacy mapping

Entity `customers:customer_person_profile`:

- `national_identification_number` → `pesel`;
- `id_type` → `document_type` by explicit dictionary mapping;
- `id_country_code` → `issuing_country_code` by explicit dictionary mapping;
- `id_number` → `document_number`;
- `id_issued_date` → `issued_on`;
- `id_expiry_date` → `expires_on`.

Legacy typo `idenitity_card` maps to `identity_card`. Unknown dictionary values increment a count-only diagnostic and yield a missing destination status; reports never print the value.

### Phase A — additive dark launch

1. Deploy module/tables/maps/role/service/API/UI/CLI with cutover disabled.
2. Run `yarn generate`; inspect migration/snapshot.
3. Run module defaults and ACL sync; verify zero automatic IOD assignments.
4. Verify scoped encryption maps and recoverable decryption before backfill.

### Phase B — idempotent backfill

1. Drain FINOO Person/application writers.
2. Run count-only dry-run.
3. Apply bounded transactions; never overwrite an active destination; count conflicts.
4. Re-run dry-run and require zero unmigrated Persons, matching record counts, expected status totals.
5. Verify raw ciphertext and authorized decrypted canaries without putting values in reports/Jira.

Invalid legacy values are copied encrypted and marked missing. New writes remain strict.

### Phase C — cutover

1. Require valid PESEL for final `finoo_applications` submission and call the write-only identity port.
2. The projector never sends the six protected values through generic Person commands, interceptors, undo snapshots, or action logs. Existing legacy values are read only by the scoped migration tool.
3. Run `cutover-legacy` to verify zero unmigrated Persons and zero source/destination conflicts, then deactivate the six definitions transactionally, closing generic read/write paths.
4. Enable safe/privileged widgets and verify roles.
5. Restart app/workers and purge FINOO structural caches.

### Phase D — short rollback window

- Retain encrypted values/inactive definitions.
- `rollback-legacy` reactivates definitions only when no allowed create/update/import/resolve audit occurred after cutover; it does not reverse-sync identity edits.
- Any post-cutover identity edit makes rollback lossy and requires manual stop/reconciliation.

### Phase E — separately approved purge

After deployed QA and fresh count-only verification, request direct approval for exact tenant/org/six definitions. Only then hard-delete active/soft-deleted values and definitions in bounded transactions, verify zero residual keys, and retain count-only evidence.

Cutover and rollback require `--apply --maintenance-window --confirm THOM-108` plus literal tenant and organization UUIDs. Purge dry-run requires literal scope; purge apply additionally requires the same maintenance-window and confirmation gates. No command has a wildcard/all-tenant mode.

### Compatibility

- Tables/routes/features are additive private contracts.
- Person responses add only namespaced safe enrichment.
- Custom-field removal is FINOO configuration but remains staged/approval-gated.
- Intake retry/idempotency stays intact; the related ingestion spec/test is updated.
- Encrypted intake identity copies have no human read API and are redacted by the Person retention erasure seam.

## Implementation Plan

### Phase 1 — domain

Add metadata, ACL/setup, entities/maps, validators, completeness, migrations/tests, narrow DI services, audit helper, locks, metadata-only effects, import and conflicts.

### Phase 2 — API/UI

Add audited raw/audit/conflict routes, safe enricher/filter, localized list/detail/form/conflict widgets and tests.

### Phase 3 — application/migration

Route application identity writes through DI, require final PESEL, remove legacy dependencies, add dry-run/apply/verify/cutover/rollback/purge CLI, update ingestion spec/tests.

### Phase 4 — rollout

Run generation/targeted checks/typecheck/lint/build/reviews, deploy exact SHA to FINOO, perform headed ordinary/IOD/superadmin QA, observe rollback, then request purge approval.

### File manifest

| Path | Action | Purpose |
|---|---|---|
| `apps/mercato/src/modules/finoo_identities/**` | Create | Domain, API, UI, migration, tests. |
| `apps/mercato/src/modules/finoo_applications/**` | Modify | Write-only integration/legacy removal. |
| `apps/mercato/src/modules.ts` | Modify | Activate private module. |
| Module locale files | Create | Polish/English UI/errors. |
| `.ai/specs/enterprise/2026-08-18-finoo-application-form-ingestion.md` | Modify | Replace custom-field assumptions. |

## Testing Strategy

Integration tests create/clean their own tenant, org, users/roles, Person, maps, legacy fields/values, and intake fixtures.

| ID | Coverage |
|---|---|
| `TC-FINOO-ID-U01` | PESEL normalization/checksum/date. |
| `TC-FINOO-ID-U02` | Field/aggregate statuses including N/A. |
| `TC-FINOO-ID-U03` | Exact IOD grants and no admin/employee/import grants. |
| `TC-FINOO-ID-U04` | Encryption map completeness. |
| `TC-FINOO-ID-U05` | Every raw route uses audited auth; safe routes never decrypt. |
| `TC-FINOO-ID-U06` | Import create/retry/conflict/no-overwrite. |
| `TC-FINOO-ID-U07` | Identity/conflict optimistic locks. |
| `TC-FINOO-ID-U08` | Migration idempotency, count-only output, purge guards. |
| `TC-FINOO-ID-001` | Ordinary user sees statuses, no protected key/value. |
| `TC-FINOO-ID-002` | Ordinary raw GET/PUT/conflict returns audited 403 without decrypt/mutate. |
| `TC-FINOO-ID-003` | IOD read/update and value-free audit. |
| `TC-FINOO-ID-004` | Superadmin standard bypass. |
| `TC-FINOO-ID-005` | IOD provisioned without assignment; admin/employee denied. |
| `TC-FINOO-ID-006` | Exact filter and explicit >200 rejection. |
| `TC-FINOO-ID-007` | Projector create/unchanged/conflict no-overwrite. |
| `TC-FINOO-ID-008` | Resolve/dismiss clears candidate ciphertext. |
| `TC-FINOO-ID-009` | Invalid legacy preservation/status and idempotent mapping. |
| `TC-FINOO-ID-010` | Cutover removes keys from customer/search/export/report and blocks writes. |
| `TC-FINOO-ID-011` | Future erasure seam removes values/nulls audit Person link. |
| `TC-FINOO-ID-012` | Headed list/detail/form QA for ordinary/IOD/superadmin. |

Fixture PESEL/document canaries are scanned across responses, logs, events, CLI output, and audit; zero occurrences are allowed outside authorized raw responses.

## Performance and Cache

- List enrichment adds one safe scoped batch query; detail adds one point query.
- Raw values load only in an authorized panel and are never cached.
- `cacheableOnListHit: false`; identity commits invalidate scoped Person list/detail tags via DI cache.
- Indexes cover active Person, completeness, open conflict, and audit-by-Person/time.
- Audit pagination is <=100; migration batches outside request handlers.
- The 200-ID filter bound fails explicitly, never silently truncates.

## Risks & Impact Review

#### Partial migration/cutover
- **Scenario:** only some Persons copy or definitions deactivate before caller switch.
- **Severity:** High
- **Affected area:** FINOO identity/application projection.
- **Mitigation:** additive schema, idempotent batches, writer drain, count verification, transactional deactivation.
- **Residual risk:** crash extends maintenance but cannot authorize deletion.

#### Concurrent IOD edits
- **Scenario:** two actors update/resolve the same record.
- **Severity:** High
- **Affected area:** one Person identity.
- **Mitigation:** `updated_at`, Person-scoped advisory locks, unique active row, transactional audit/completeness.
- **Residual risk:** later actor reloads/reapplies.

#### Import overwrite
- **Scenario:** later form differs from existing identity.
- **Severity:** Critical
- **Affected area:** protected values.
- **Mitigation:** no technical update path; encrypted conflict; authorized reviewed replace only.
- **Residual risk:** authorized reviewer can choose incorrectly; action remains attributable.

#### Identity service outage
- **Scenario:** DI/module unavailable during projection.
- **Severity:** High
- **Affected area:** FINOO intake projection.
- **Mitigation:** fail closed, retain encrypted intake, retry, no custom-field fallback.
- **Residual risk:** CRM projection delay.

#### Cross-scope raw read
- **Scenario:** caller supplies another Person/org.
- **Severity:** Critical
- **Affected area:** all identity values.
- **Mitigation:** resolve scope before auth; all queries tenant+org+Person; no unscoped fallback; cross-scope tests.
- **Residual risk:** explicit platform-superadmin capability remains audited.

#### Completeness side channel
- **Scenario:** masks/reasons/timing reveal partial data.
- **Severity:** High
- **Affected area:** safe surfaces.
- **Mitigation:** fixed enum only; no decrypt/reason/length/mask; stable shapes.
- **Residual risk:** staff learn a field is missing, the required outcome.

#### Invalid legacy loss
- **Scenario:** strict validation rejects history.
- **Severity:** High
- **Affected area:** migrated records.
- **Mitigation:** migration-only encrypted preservation marked missing; count-only reports.
- **Residual risk:** unusable until IOD correction.

#### Rollback divergence
- **Scenario:** post-cutover identity edits are absent from legacy fields.
- **Severity:** High
- **Affected area:** rollback accuracy.
- **Mitigation:** short window; edits trigger manual stop/reconciliation; no insecure reverse sync.
- **Residual risk:** rollback may be intentionally declined.

#### Wrong-scope purge
- **Scenario:** cleanup targets other data.
- **Severity:** Critical
- **Affected area:** custom-field storage.
- **Mitigation:** literal scope/allowlist, dry-run, THOM-108 token, fresh approval, bounded transactions/read-back.
- **Residual risk:** approved deletion is irreversible outside backups.

#### Sensitive logging/audit
- **Scenario:** errors/snapshots/events/CLI leak values.
- **Severity:** Critical
- **Affected area:** logs, audit, Jira, CI.
- **Mitigation:** dedicated value-free metadata, stable codes, canary scans, no generic snapshots.
- **Residual risk:** privileged DB tooling follows separate operations policy.

#### Filter exceeds 200
- **Scenario:** matched Persons exceed shared IDs transport.
- **Severity:** Medium
- **Affected area:** list filtering.
- **Mitigation:** explicit 422/count preflight; future query-engine join.
- **Residual risk:** staff narrow criteria; correctness/confidentiality remain intact.

#### Audit growth
- **Scenario:** frequent views grow append-only storage.
- **Severity:** Medium
- **Affected area:** DB size/query latency.
- **Mitigation:** compact fixed columns, no snapshots, indexes, bounded pages, erasure anonymization.
- **Residual risk:** anonymized audit retention needs a later approved policy.

## Final Compliance Report — 2026-08-24

### AGENTS.md Files Reviewed

- `AGENTS.md`
- `packages/core/AGENTS.md`
- `packages/core/src/modules/auth/AGENTS.md`
- `packages/core/src/modules/customers/AGENTS.md`
- `packages/shared/AGENTS.md`
- `packages/ui/AGENTS.md`
- `packages/ui/src/backend/AGENTS.md`
- `.ai/specs/AGENTS.md`
- `.ai/qa/AGENTS.md`
- `BACKWARD_COMPATIBILITY.md`
- `.ai/docs/module-development.md`
- `.ai/ds-rules.md`
- `.ai/ui-components.md`

### Verification Evidence — 2026-08-25

- PostgreSQL `TC-FINOO-ID-001-005`: PASS for ordinary status-only access, automatically provisioned IOD role with the exact three features and zero automatic assignments, IOD raw access, and superadmin wildcard access.
- PostgreSQL `TC-FINOO-APP-001`: PASS for signed intake, mandatory PESEL, encrypted projection, retry/conflict/recovery/concurrency/retention, and corrupt-state fail-closed behavior.
- Headed desktop QA: PASS for ordinary status-only, IOD raw identity, and superadmin raw identity views; ordinary 390x844 QA also exposes six statuses and no raw controls.
- Current task-tree PostgreSQL integration, unit tests, typecheck, lint, generation, and application build: PASS after integration of `origin/fork/finoo`. Headed role QA predates that final merge, whose production-code delta is the separate fail-closed rejection of a retired completion field.
- Production migration, cutover, rollback, retention execution, and permanent purge were not run. Purge apply remains separately approval-gated.

### Compliance Matrix

| Rule source | Rule | Status | Notes |
|---|---|---|---|
| root | Private app-module placement | Compliant | `finoo_identities`. |
| root | No cross-module ORM relations | Compliant | Scalar ID + DI/enricher/interceptor/widget. |
| root | Tenant/org scope | Compliant | Explicit invariant/tests. |
| root | Feature authorization | Compliant | Immutable IDs; role name is provisioning only. |
| root/core | Encryption helpers/maps | Compliant | Module maps + scoped decrypt helpers. |
| root | Optimistic locking | Compliant | Identity/conflict version guards. |
| core | Commands and route guards | Compliant with documented exception | Raw values stay out of generic command surfaces; routes pass safe changed-field metadata to mutation guards and service supplies locks/audit/cache/events. |
| core | Sanctioned integration seams | Compliant | Enricher/interceptor/widgets/DI. |
| shared/UI | API helpers/i18n/CrudForm/DS | Compliant | Planned canonical primitives. |
| QA/spec | API/UI integration coverage | Compliant for in-scope paths | PostgreSQL API integration and headed ordinary/IOD/superadmin role QA passed; production cutover and purge execution remain rollout operations, not implementation acceptance. |
| compatibility | Additive/staged removal | Compliant | Deactivate then separately approved purge. |

### Internal Consistency Check

| Check | Status | Notes |
|---|---|---|
| Models match APIs | Pass | Raw/safe/conflict/audit ownership explicit. |
| APIs match UI | Partial | Safe host enrichment + privileged panel pass; People v2 visible aggregate filter needs a platform extension follow-up. |
| Risks cover writes | Pass | Human/import/conflict/migration/rollback/purge/erasure. |
| Mutation side effects covered | Pass | Runtime service supplies guards, locks, audit, cache invalidation, and events; migration is operator CLI. |
| Cache covers reads | Pass | Raw uncached; safe scoped invalidation. |
| Authorization covers raw paths | Pass | Central helper + route tests. |
| Retention clock is singular | Pass | Person clock remains external. |

### Non-Compliant Items

- The People v2 advanced-filter panel cannot discover module-injected column/filter metadata. The safe API filter is implemented and tested, but a visible aggregate filter requires a separate additive platform extension; raw access and per-field status acceptance are unaffected.

### Verdict

- **Compliant for the THOM-108 private identity boundary:** PostgreSQL integration and headed role QA passed. The visible People v2 aggregate-filter extension remains a separate platform follow-up; production migration, cutover, retention invocation, and permanent purge remain unexecuted rollout operations.

## Changelog

### 2026-08-24

- Added the FINOO-private identity-access design from the completed `grill-me` decisions and THOM-108 scope.
- Defined encrypted current identity, safe completeness, IOD/superadmin authorization, write-only ingestion, conflicts, dedicated audit, staged migration/rollback/purge, and Person-retention integration.

### 2026-08-25

- Added PostgreSQL and headed role evidence, exact IOD provisioning grants, successful rollback coverage, and bounded permanent-purge transactions with zero-residual read-back.

### Review — 2026-08-25

- **Primary deep review:** initial purge, recovery/provisioning-test, and evidence-documentation findings were fixed; targeted follow-up passed with no unresolved finding.
- **Security review:** passed after the purge/provisioning hardening; no authorization, privacy, raw-data disclosure, scope, or resumability regression found.
- **Performance:** passed with explicit 200-match identity-filter bound and bounded purge transactions.
- **Cache and mutation side effects:** passed with the documented raw-command-surface exception.
- **Verdict:** approved for private branch publication and later FINOO rollout planning. Production deployment, migration, cutover, retention execution, and permanent purge remain separately gated.
