# Run: Link dialog preview stays visible after deselecting a person

Date: 2026-08-21
Slug: `link-dialog-preview-stale-after-deselect`
Branch: `fix/link-dialog-preview-stale-after-deselect`
Base: `fork/crm-they-dev`
Engine: om-auto-create-pr (steps: 6, --loop: no)

## Goal

Make the right-hand PREVIEW / LINK SETTINGS panel of the entity-linking modal stop showing a person
(or company/deal) that is no longer part of the current selection.

## Context

The "Link existing person" button on CRM detail pages opens the shared
`packages/core/src/modules/customers/components/linking/LinkEntityDialog.tsx`. The same dialog backs
every linking flow in the module — `CompanyPeopleSection`, `PersonCompaniesSection`, `DealsSection`
and `DealLinkedEntitiesTab` — which is why the report says the problem shows up "in multiple places".

The dialog keeps two independent pieces of state:

- `draftIds` — the pending selection, rendered in the left list and the right-hand SELECTED card.
- `focusedId` — which entry the right-hand PREVIEW and LINK SETTINGS blocks describe.

`handleRowClick` sets `setFocusedId(option.id)` unconditionally and only then toggles selection, so
deselecting a row leaves `focusedId` pointing at an entry that is no longer selected. The result is
the reported state: the footer reads "0 people selected", the SELECTED card reads "No people
selected.", and the PREVIEW card still renders the person plus their link settings.

## Scope

- Restore the invariant "`focusedId` always references an entry in `draftIds`, or is `null`" at the
  one site that can remove an id from the selection.
- When the focused entry is deselected while other entries remain selected, move the preview to the
  last remaining selected entry instead of blanking it, so the LINK SETTINGS block stays reachable.
- Regression unit tests in the existing `LinkEntityDialog.test.tsx` suite.

## Non-goals

- No change to the dialog's layout, styling or copy.
- No change to the adapters (`personAdapter`, `companyAdapter`, `dealAdapter`) or to any calling
  section component.
- No change to the link/unlink API contract, the confirm payload shape, or `linkSettings` semantics.
- No new removal affordance (e.g. an "x" on SELECTED rows) — out of scope for this report.

## Risks

- Low blast radius: one callback in one client component, no contract surface touched.
- The behavioral nuance worth watching is the fallback: deselecting the focused entry now re-points
  the preview at another selected entry rather than clearing it outright. Clearing unconditionally
  would have hidden LINK SETTINGS while a selection was still pending, which is a worse regression
  than the bug being fixed. Covered by a dedicated test.
- No CI runs on `fork/crm-they-dev` PRs, so the local validation gate is the only evidence.

## Implementation Plan

### Phase 1: Fix the focus/selection invariant

1.1 Rework `handleRowClick` in `LinkEntityDialog.tsx` so deselecting the focused entry re-points
    `focusedId` at the last remaining selected entry, or clears it when nothing remains selected.

1.2 Add regression tests to `__tests__/LinkEntityDialog.test.tsx` covering: preview cleared when the
    only selected entry is deselected; preview moved to the remaining entry when the focused entry is
    deselected; preview untouched when a non-focused entry is deselected.

1.3 Run the targeted test file locally.

### Phase 2: Validation and delivery

2.1 Run the full `validation.commands` gate from `.ai/agentic.config.json` in local mode.

2.2 Open/refresh the PR against `fork/crm-they-dev`, apply pipeline labels.

2.3 Run `om-auto-review-pr --autofix` and post the summary comment.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Fix the focus/selection invariant

- [x] 1.1 Rework handleRowClick so deselection updates focusedId — 6befe74e8
- [x] 1.2 Add regression tests for preview clearing and fallback — 6befe74e8
- [x] 1.3 Run the targeted test file — 6befe74e8

### Phase 2: Validation and delivery

- [ ] 2.1 Run the full validation gate
- [ ] 2.2 Open the PR and apply labels
- [ ] 2.3 Run om-auto-review-pr and post the summary comment
