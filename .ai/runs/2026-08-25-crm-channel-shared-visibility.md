# Run: CRM Conversation Shared Visibility

**Engine:** om-auto-create-pr (steps: 16, --loop: no)
**Source doc:** `.ai/specs/2026-08-25-crm-channel-shared-visibility.md`
**Readiness audit:** `.ai/specs/analysis/ANALYSIS-2026-08-25-crm-channel-shared-visibility.md`
**Branch:** `feat/crm-channel-shared-visibility`
**Base:** `fork/crm-they-dev`
**Status:** in-progress

## Goal

Let a personal-mailbox owner share their whole email conversation with one CRM Person with the team, retroactively and reversibly, without ever rewriting per-message visibility — and consolidate the five existing email-visibility enforcement sites first so the widening cannot fail open.

## Base branch determination (deviation from config, recorded deliberately)

`.ai/agentic.config.json` declares `baseBranch: develop`, but this run targets **`fork/crm-they-dev`**. Rationale, from evidence rather than assumption:

- This worktree's HEAD is exactly `origin/fork/crm-they-dev` (ahead 0 / behind 0), and that branch is **3756 commits ahead** of `origin/develop`. A PR against `develop` would carry all 3756 fork commits, not this change.
- Repo convention confirms the split: CRM instance work of exactly this shape targets the fork branch — PR #17 (merged, `fork/crm-they-dev <- fix/link-dialog-preview-stale-after-deselect`, a `packages/core/.../customers` fix) and PR #16 (open, `fork/crm-they-dev <- fix/customers-next-interaction-silent-field-drop`). Only `contrib/*` and `ops/*` branches target `develop`.
- The instance contract marks `fork/crm-they-dev` FORK-ONLY: never open an upstream PR from it.

The change touches no fork-only path (it is entirely `packages/core/src/modules/customers/`), so promoting it upstream later via a `contrib/*` branch off `develop` remains possible as separate work.

## Scope

- `packages/core/src/modules/customers/` — the visibility helpers, the two bypassing enrichers, the ingestion default, a new share entity + migration, ACL/events/setup, a share service + command + API route, the Emails-tab UI, i18n (5 locales), unit + integration tests.

## Non-goals

- **No `communication_channels.visibility` column** (spec Q1). A channel-wide flag is not needed to satisfy the brief and its `DEFAULT 'private'` migration would silently un-share every existing tenant-wide channel.
- **No admin oversight / escalation** (spec Q4). `customers.email.view_private` and `communication_channels.admin` stay inert; activating either would retroactively expose every private email in every tenant, since both are already granted via `admin: ['customers.*']`.
- **No `customer_interactions.channel_id` denormalisation or backfill** (spec Q3). Keying the share on `(person, owner_user_id)` reuses the existing covering index instead.
- No row rewrites of `customer_interactions.visibility`; no GDPR-erasure-scope changes; no notification type.

## Risks

- The filter-fragment contract change (Step 1) is the single highest-risk edit: 2 of 4 MikroORM callers currently spread only `.$or` and would silently drop a new arm. Mitigated by converting all four in the same commit plus a unit test that a non-`$or` arm survives.
- Widening a privacy predicate risks over-exposure. Mitigated by keeping every default fail-closed (absent share list ⇒ byte-identical to today) and asserting the v1 owner-only behaviour still ignores caller features.
- `yarn build:app` in the gate is slow; the gate runs once at completion per phase-targeted validation earlier.

## Implementation Plan

### Phase 1: Consolidate enforcement (no behaviour change)

Prerequisite for everything after it — makes the widening safe.

### Phase 2: Share model and write path

### Phase 3: Read widening

### Phase 4: UI and i18n

### Phase 5: Tests and gate

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Consolidate enforcement

- [x] 1.1 Fix the filter-fragment contract to an opaque FilterQuery; convert all four MikroORM callers; unit-test non-$or arm survival — 81736cfc1
- [x] 1.2 Route the two inline visibility defaults in link-channel-message-handler onto resolveVisibility() — 81736cfc1
- [x] 1.3 Move privateEmailCountEnricher and interactionEmailCardEnricher onto the shared predicate — 81736cfc1

### Phase 2: Share model and write path

- [x] 2.1 Add the CustomerEmailConversationShare entity — d6ce590fb
- [x] 2.2 Author the migration and update the module snapshot — d6ce590fb
- [x] 2.3 Declare the ACL feature, setup grant, and the new event id — d6ce590fb
- [x] 2.4 Add the conversation-share service and register it in DI — d6ce590fb
- [x] 2.5 Add the share command and the GET/PUT API route — d6ce590fb

### Phase 3: Read widening

- [x] 3.1 Widen both shared predicates with an optional, fail-closed sharedConversations arm — d6ce590fb
- [x] 3.2 Wire the share lookup into every email read path — d6ce590fb
- [ ] 3.3 Add the optional sharedVia / sharedByUserName response fields

### Phase 4: UI and i18n

- [x] 4.1 Build the Emails-tab share switch, confirm dialog, and "Shared by" badge — ef5853002
- [x] 4.2 Add i18n keys to all five locale files — ef5853002

### Phase 5: Tests and gate

- [ ] 5.1 Unit tests for the widened predicates and the inert-feature assertion
- [ ] 5.2 Integration tests extending the TC-CRM-EMAIL-VISIBILITY family
- [ ] 5.3 Run the full validation gate and fix fallout
</content>
