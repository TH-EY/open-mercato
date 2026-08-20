# Execution plan — customers: stop silently dropping unknown PUT fields (next-interaction round-trip)

**Date:** 2026-08-20
**Slug:** `customers-next-interaction-silent-field-drop`
**Branch:** `fix/customers-next-interaction-silent-field-drop`
**Base branch:** `fork/crm-they-dev` (this fix must land on the branch crm.they.dev runs; the touched
files are all under `packages/core/src/modules/customers/**` and contain no fork-only paths, so the
same commits can be cherry-picked into a `contrib/*` PR against upstream `develop` later)

## Goal

`PUT /api/customers/people` returns `200 {ok:true}` while silently discarding fields it does not
recognise. Make an unrecognised field a loud `400`, and make the next-interaction read shape
round-trip on write so a read-modify-write client stops losing reminder dates.

## Reported symptom

> `PUT /api/customers/people` with `nextInteraction` in the same payload as `primaryPhone` returned
> 200 but silently ignored the date. Sending a separate PUT with only `nextInteraction` was needed.
> Later: separate sequential PUTs all returned 200 and the date still did not persist; only an
> identical repeat PUT worked. Silent field omission on success is the worst possible failure mode —
> the sender has no way to notice.

## Root cause (confirmed by reading the code)

1. **Unknown keys are stripped silently.** `packages/core/src/modules/customers/api/people/route.ts`
   parses the PUT body with `personUpdateSchema` (`data/validators.ts`), a plain non-strict zod
   object. Zod's default `strip` behaviour drops every key the shape does not declare, the command
   runs on the remainder, and the route answers `200 {ok:true, updatedAt}`. Nothing anywhere reports
   the dropped key. The same holds for `/api/customers/companies` and for the create actions.

2. **The next-interaction read shape and write shape differ.** This is why that stripping bites on
   this field specifically:

   | Surface | Shape |
   |---------|-------|
   | `GET /api/customers/people/{id}` | `nextInteractionAt`, `nextInteractionName`, `nextInteractionRefId`, `nextInteractionIcon`, `nextInteractionColor` (flat, camelCase) |
   | `GET /api/customers/people` (list) | `next_interaction_at`, `next_interaction_name`, … (flat, snake_case) |
   | `PUT /api/customers/people` | `nextInteraction: { at, name, refId?, icon?, color? }` (nested, `.strict()`, `name` required) |

   A client that reads a person and PUTs the record back sends `nextInteractionAt` — which no write
   schema declares, so it is stripped and the write is a no-op returning 200. `primaryPhone` has the
   same name on both sides, so it saves. That is exactly the reported
   "phone saved, date silently ignored in the same payload".

## Secondary finding (verify-and-report, not fixed here)

`next_interaction_*` on `customer_entities` is a **derived projection** of `customer_interactions`.
`lib/interactionProjection.ts#recomputeNextInteraction` rewrites all five columns from the earliest
open, dated, non-deleted interaction — and NULLs them when there is none. It runs inside every
interaction command (`commands/interactions.ts`: create / update / complete / cancel / delete plus
their undo/redo paths) and from `customers.interaction.recompute_next`.

A value written straight through the person/company PUT has no backing `customer_interactions` row,
so the next interaction command touching that entity overwrites it — usually to NULL. That is a
second, independent way a manually-set reminder disappears (last-writer-wins between two owners of
the same columns, not a timing race). Deciding who owns those columns is a contract change and falls
under the repo's "Ask First" rule, so it is reported on the PR as a follow-up rather than changed here.

## Scope

- `packages/core/src/modules/customers/api/people/payload.ts` — extend the existing payload
  normaliser (it already 400s on an unsupported `profile.*` key; this is the missing top-level twin).
- `packages/core/src/modules/customers/api/companies/` — same treatment, the surface is symmetric.
- `packages/core/src/modules/customers/api/{people,companies}/route.ts` — wire it into create+update.
- `packages/core/src/modules/customers/i18n/*.json` — error copy in all five locales.

## Non-goals

- Changing who owns the `next_interaction_*` projection columns (see Secondary finding).
- Touching `commands/people.ts` / `commands/companies.ts` write logic — they are correct.
- Touching the deals / interactions payload surfaces.
- Any fork-only path, infra, or deployment file.

## Risks

- **Strictness could reject a payload the app itself sends.** Mitigated by auditing every in-repo
  call site first (`buildPersonPayload` / `buildPersonEditPayload` / `buildCompanyEditPayload`, the
  v1 inline-edit patches, the v2 form submit) and by allowing benign round-trip keys (`id`,
  `updatedAt`, `createdAt`) explicitly. `sync_excel` calls the command bus directly and bypasses the
  route mapInput, so it is unaffected.
- **Behaviour change for external API clients**: a payload that used to 200-and-drop now 400s. That
  is the point of the fix, but it is called out in the PR body and the error names the offending
  fields plus the accepted spelling.

## Implementation Plan

### Phase 1: Lock the current behaviour with failing tests
- Reproduce the silent drop and the read/write shape asymmetry as unit tests before changing code.

### Phase 2: Reject unrecognised top-level payload fields
- Shared helper + wiring into people and companies create/update.

### Phase 3: Make the next-interaction read shape round-trip on write
- Fold the flat `nextInteraction*` keys into the nested object the schema expects.

### Phase 4: Locale copy and API documentation
### Phase 5: Full validation gate

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Lock the current behaviour with failing tests

- [ ] 1.1 Add a unit test proving `PUT /api/customers/people` mapInput drops `nextInteractionAt` and reports success
- [ ] 1.2 Add a unit test proving an arbitrary misspelled field is dropped without error

### Phase 2: Reject unrecognised top-level payload fields

- [ ] 2.1 Add `assertNoUnknownPayloadFields` with a did-you-mean hint for known read-shape aliases
- [ ] 2.2 Wire it into the people create and update mapInput
- [ ] 2.3 Wire it into the companies create and update mapInput

### Phase 3: Make the next-interaction read shape round-trip on write

- [ ] 3.1 Add `foldFlatNextInteractionPayload` (flat camelCase + snake_case -> nested, null clears)
- [ ] 3.2 Wire the fold ahead of the unknown-field check on people and companies
- [ ] 3.3 Cover the fold with unit tests (set, clear, conflict, missing name)

### Phase 4: Locale copy and API documentation

- [ ] 4.1 Add the new error keys to en/pl/de/es/ko
- [ ] 4.2 Document the accepted next-interaction write shapes in the OpenAPI update descriptions

### Phase 5: Full validation gate

- [ ] 5.1 Run the configured `validation.commands` gate green
