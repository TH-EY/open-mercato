<!--
Please ensure this pull request targets the `develop` branch.
Checking the CLA box below confirms you accept the terms in docs/cla.md.
-->

## Summary

Provide a concise description of the problem and the proposed solution.

## Track

- [ ] `contrib/*` – intended to stay upstream-candidate friendly
- [ ] `fork/*` – intentionally fork-only
- [ ] `sync/*` – branch used only for sync or extraction work

## Changes

- bullet the key code or documentation updates

## Specification

<!-- We follow spec-driven development. Please check if a spec exists and update it accordingly. -->

**Does a spec exist for this feature/module?**
- [ ] Yes
- [ ] No (created a new spec)
- [ ] N/A (minor change, no spec needed)

**Spec file path:**
<!-- Example: .ai/specs/notifications-module.md -->


## Testing

List the tests or commands you ran to validate the change.

## Checklist

- [ ] This pull request targets `develop`.
- [ ] I have read and accept the Open Mercato Contributor License Agreement (see `docs/cla.md`).
- [ ] I updated documentation, locales, or generators if the change requires it.
- [ ] I added or adjusted tests that cover the change.
- [ ] I added or updated integration tests in `.ai/qa/tests/` (or documented why integration coverage is not required).
- [ ] I created or updated the spec in `.ai/specs/` with a changelog entry (if applicable).

## Upstreamability

- [ ] This branch was created from a fresh `develop`.
- [ ] This change is isolated from fork-only history, or this PR is explicitly fork-only.
- [ ] This change still makes sense without this fork's deployment, branding, or local business rules.
- [ ] I preferred a module, extension point, or provider package over a fork-only core patch.
- [ ] I checked `BACKWARD_COMPATIBILITY.md` for any touched contract surface.
- [ ] I ran the strict local quality gate from `docs/upstream-contribution-workflow.md` (or documented the exception).

## Linked issues

Reference any related issues with `Fixes #...` when applicable.
