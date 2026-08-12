# Pre-Implementation Analysis: Finoo Affiliate Portal and Attribution

## Executive Summary

The spec is coherent and additive, and its private app-module boundary is appropriate. It is not ready for code yet: the first review found four must-fix gaps—PII snapshot encryption, command/undo contracts for staff mutations, explicit cache/performance decisions, and a simpler complete self-registration switch covering every signup CTA as well as the route/API. Once those items are added, no backward-compatibility blocker remains.

## Backward Compatibility

### Violations Found

No existing contract is removed, renamed, or narrowed. The audit covered all 13 frozen/stable surfaces:

| # | Surface | Result | Severity | Proposed Fix |
|---|---|---|---|---|
| 1 | Auto-discovery conventions | New app module uses existing conventions only | None | N/A |
| 2 | Type definitions | Only a proposed optional portal-shell prop | None | Keep optional with current default |
| 3 | Function signatures | No required parameter changes | None | N/A |
| 4 | Import paths | No move/removal | None | N/A |
| 5 | Event IDs | Existing customer event IDs are consumed unchanged | None | N/A |
| 6 | Widget spot IDs | Existing portal/deal spots are consumed unchanged | None | N/A |
| 7 | API routes | New Finoo routes only; signup is disabled by app override, not removed from core | None | Test override isolation |
| 8 | Database schema | Additive app-owned tables only | None | Generate and review migration |
| 9 | DI service names | New app registration only | None | N/A |
| 10 | ACL feature IDs | New IDs only | None | Seed default grants |
| 11 | Notification type IDs | Not used | None | N/A |
| 12 | CLI commands | Not changed | None | N/A |
| 13 | Generated contracts | Regenerated additively | None | Run `yarn generate` and diff generated outputs |

### Missing BC Section

The spec contains a complete “Migration and Backward Compatibility” section. No deprecation bridge is required.

## Spec Completeness

### Missing Sections

| Section | Impact | Recommendation |
|---|---|---|
| Proposed Solution | The design is present but spread across Overview and Architecture | Add a short explicit section naming the chosen module, seams, and read model |
| Commands and Undo | Staff writes would otherwise bypass the project's command/audit/undo contract | Name commands, snapshots, emitted events, and undo behavior for links and Deal attributions |
| Encryption | `company_name`, landing page, and initial referrer can contain personal/free-text data | Add module `encryption.ts`, encrypted columns, decryption-aware reads, and state which fields intentionally remain plaintext |
| Cache Strategy | Read/write invalidation behavior is undefined | Declare no cache for MVP, justify bounded indexed queries, and avoid stale cross-tenant cache risk |

### Incomplete Sections

| Section | Gap | Recommendation |
|---|---|---|
| Disabled Signup | Hiding only the shared shell CTA misses signup links in portal landing and login pages | Use one generic default-true portal self-registration config seam in all public portal surfaces; keep app route/API overrides as the hard enforcement |
| API Contracts | OpenAPI and mutation-guard/command behavior are not explicit | Require `metadata` + `openApi` for every route, `makeCrudRoute` for link CRUD, and command-backed guarded write for attribution |
| Performance | Offset pagination and query count are not justified | State expected Finoo cardinality, maximum range, supporting indexes, and bounded query counts; defer keyset pagination until evidence warrants it |
| Events | Own module mutations do not yet name events | Declare singular past-tense link/attribution lifecycle events and generate registries |
| Data Extension | Deal record is described as an extension but no UMES data link is named | Declare app-owned `data/extensions.ts` FK-ID link to `customers.deal` |

## AGENTS.md Compliance

### Violations

| Rule | Location | Fix |
|---|---|---|
| GDPR-relevant fields require module encryption maps and decryption-aware reads | Data Model / CRM Attribution | Add `encryption.ts`; encrypt snapshot display strings; use `findWithDecryption`/`findOneWithDecryption` with tenant and organization scope |
| All mutations use commands and define undo/redo | Staff APIs / Implementation Plan | Add link create/update/delete and attribution upsert/update commands with before/after snapshots, optimistic locking, side effects, and inverse behavior |
| Custom non-`CrudForm` writes use guarded mutation plumbing | Deal Extension Tab | Make the page-level injected tab receive/use a guarded mutation runner and expose `retryLastMutation`; avoid raw local write calls |
| All routes export per-method metadata and OpenAPI | APIs | Add this requirement explicitly and cover it in tests |
| Cross-module extension records use sanctioned extension declarations | Data Model | Add `data/extensions.ts` using a scalar Deal ID link; retain no ORM relation |
| Shared app-shell changes require template-parity consideration | Disabled Signup | Prefer a generic core/UI config seam; intentionally do not copy Finoo module enablement into create-app template; run parity check and document the expected app-specific delta |

## Risk Assessment

### High Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Tenant/affiliate authorization defect | Another affiliate could see leads or commission data | Derive affiliate ID from portal auth, use wildcard-aware feature checks, and filter every query by tenant + organization + user; add negative integration fixtures |
| Open redirect or scriptable destination | Public endpoint could redirect users to attacker-controlled hosts | Validate exact HTTPS hosts both on link write and redirect, fail closed, and return indistinguishable 404s |
| Concurrent visit duplicates | Dashboard clicks inflate under parallel requests | Parameterized service-level transaction with advisory lock and executable two-contender test |
| Unencrypted snapshots | URLs/referrers/company names may retain personal data in plaintext | Add encryption maps and decryption-aware reads before implementation |
| Money/commission lost update | Staff overwrites another editor's changes | `updated_at` optimistic locking, structured 409, unified conflict UI, and browser conflict coverage |

### Medium Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Persistent subscriber retry/race | Duplicate attribution or later transaction time | Scoped unique Deal constraint, idempotent upsert, earliest timestamp comparison, and retry tests |
| Signup links remain visible | Users reach a dead or misleading flow | Central default-true self-registration config controls shell, landing, and login CTAs; route/API overrides remain the enforcement layer |
| Cross-module schema coupling | Customer entity changes could break synchronizer | Keep imports server-only, no relations/business-service calls, use sanctioned custom-field helpers and extension declaration, cover current payload shapes |
| Dashboard query growth | Large date ranges could slow reads | Cap at 366 days, use time/affiliate indexes, aggregate in three bounded queries, no unbounded raw events response |

### Low Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Dictionary labels change | Portal display could drift | Validate dictionary key and persist normalized value snapshot |
| Bot filter false positives/negatives | Some legitimate or automated visits are misclassified | Deterministic documented list, route tests, no claim of perfect bot detection |
| Template sync warning | Private app delta appears as template drift | Run check, classify the intentional `modules.ts` delta, and do not sync private Finoo configuration into the public template |

## Gap Analysis

### Critical Gaps (Block Implementation)

- Encryption contract: define the module encryption map and encrypted snapshot reads.
- Command contract: define command IDs, optimistic locking, event/audit side effects, and undo behavior for every staff mutation.
- Self-registration UX seam: cover shared shell, portal landing, and portal login CTAs, not only route/API enforcement.

### Important Gaps (Should Address)

- Add explicit no-cache and query-count decisions.
- Add API `metadata`/`openApi` and custom mutation-guard requirements.
- Add module event IDs and `data/extensions.ts` declaration.
- State expected cardinality and justify offset pagination for the Finoo-sized lead/link lists.

### Nice-to-Have Gaps

- Retain aggregate visit timestamps, but anonymize visitor hashes after their 24-hour deduplication purpose expires through the existing scheduler/queue infrastructure.
- Consider immutable link-destination history only if commission disputes require evidence beyond current snapshots.

## Remediation Plan

### Before Implementation (Must Do)

1. Amend the spec with encryption maps, command/undo contracts, no-cache/query strategy, module events, data extension, route metadata/OpenAPI, and the complete signup config seam.
2. Re-run the checklist against the amended spec and append the required review verdict to its changelog.
3. Verify the exact route-override keys and current custom-field/event payload behavior in code.

### During Implementation (Add to Spec)

1. Keep raw SQL in a tested module service, never an API route, and use only parameterized statements.
2. Use wildcard-aware shared feature matching in widgets/navigation and feature metadata on all routes/pages.
3. Run `yarn generate`, generated migration review, focused tests, i18n checks, typecheck, lint, and build in the isolated worktree.

### Post-Implementation (Follow Up)

1. Perform one fresh primary review and one orthogonal security review.
2. Deploy the exact verified SHA to Finoo only, run headed desktop/narrow QA, and attach durable evidence to THOM-88.
3. Keep generic analytics evolution outside THOM-88; include only bounded visitor-hash anonymization required by the implemented 24-hour identity window.

## Remediation Verification — 2026-08-12

The spec now includes all required remediations: an explicit Proposed Solution, module encryption maps and decryption-aware reads, command/undo/event contracts, `data/extensions.ts`, per-route metadata/OpenAPI expectations, mutation guards, a no-cache/query-count strategy, cardinality justification, and a default-preserving signup display seam covering shell, landing, and login while the disabled API plus Finoo frontend middleware enforce the denial. A second pass found no remaining Critical or Important gap.

## Recommendation

Ready to implement. The remaining work is code, generated migration review, verification, review, deployment, and QA; no additional business decision is required.
