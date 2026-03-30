# Contributing to Open Mercato

We’re excited to collaborate with folks building on top of Open Mercato. This guide explains how we organize releases, structure branches, and prepare pull requests so changes land smoothly.

## Branch Model

- `main` – release-ready code. Every commit is tagged and deployable. Keep PRs targeting `main` limited to hotfixes or release prep approved by maintainers.
- `develop` – nightly builds and upcoming release work. Base regular feature work off `develop` so it can soak in automation and shared testing.
- Topic branches – create a dedicated branch per change using the format `feat/<concise-feature-name>` (for example `feat/customer-export`). Use other prefixes when appropriate (`fix/`, `chore/`, `docs/`).

## Fork Workflow for This Repository

This fork uses a dual-track model so we can keep shipping fork-specific work while preparing clean future contributions to Open Mercato.

- `develop` in this fork is both the **deployment branch** and the base for upstream contributions. It contains `upstream/develop` plus a fork-only overlay (infra, deploy workflows, fork docs).
- `main` is a pure mirror of `upstream/main` (release tracking only, not used for deployment or fork-only work).
- Branch prefixes in this fork:
  - `contrib/*` – potential upstream contributions, always branched from a fresh `develop`
  - `fork/*` – fork-only work that is allowed to depend on fork-specific decisions
  - `sync/*` – short-lived upstream sync or extraction branches
- Never develop directly on `develop` or `main`.
- Never merge `main` into `develop`.
- If a fix started on the fork-only track later proves upstreamable, re-create it on a fresh `contrib/*` branch from `develop` instead of reusing `main` history.

See [`docs/upstream-contribution-workflow.md`](docs/upstream-contribution-workflow.md) for the operational workflow and strict local quality gate.

## Working on Features

- Branch from `develop`, keeping it up to date via `git pull --rebase origin develop`.
- Keep commits scoped and descriptive. Squash locally if it clarifies the story.
- Follow module conventions from [`AGENTS.md`](AGENTS.md) and prefer the `packages/` workspace for new code.
- Document user-facing copy in the locale dictionaries and keep translations in sync.
- In this fork, choose the branch family before writing code:
  - use `contrib/*` for anything that could plausibly be proposed upstream
  - use `fork/*` only for intentionally local work
- Keep `contrib/*` branches cherry-pickable onto a clean `develop`: one logical topic per commit, no mixed fork-only and upstream-candidate changes in the same commit.

### Spec Driven Development

Before implementing new features or making significant changes, check for an existing spec in `.ai/specs/`:

1. **Check for a spec**: Look for specs named `SPEC-###-YYYY-MM-DD-{title}.md` related to your feature
2. **Create or update**: If no spec exists, create one following the naming convention `SPEC-{next-number}-{YYYY-MM-DD}-{title}.md`; if it does, update it with your changes
3. **Maintain the changelog**: Add a dated entry summarizing your changes
4. **Update the directory**: Add new specs to the table in [`.ai/specs/README.md`](.ai/specs/README.md)

This ensures design decisions are documented and the codebase remains well-understood by both humans and AI agents. See [`.ai/specs/README.md`](.ai/specs/README.md) for the full specification directory and [`.ai/specs/AGENTS.md`](.ai/specs/AGENTS.md) for detailed guidelines.

### Syncing with Upstream

Before starting new `contrib/*` work, and at least once a week for active branches:

1. `git fetch upstream --prune`
2. fast-forward local `develop` to `upstream/develop`
3. fast-forward `origin/develop` to the same commit
4. rebase open `contrib/*` branches onto the refreshed `develop`

Do not merge fork-only history into `develop`. If you need functionality that only exists on the fork track, either extract a clean version for `contrib/*` or classify the work as fork-only.

### Strict Local Quality Gate for `contrib/*`

Before opening a future upstream PR from this fork, run:

```bash
yarn build:packages
yarn generate
yarn build:packages
yarn check:dep-versions
yarn i18n:check-sync
yarn i18n:check-usage
yarn typecheck
yarn test
yarn build:app
```

Also run `yarn test:integration` whenever the change touches UI flows, CRUD or API contracts, generators, auto-discovery, extension points, injection, or event delivery.

## Pull Requests

- Open PRs against `develop` unless you are coordinating a release hotfix.
- Describe the user impact, architectural notes, and testing performed (lint, unit, integration, CLI).
- Ensure the branch merges cleanly and CI is green before requesting review.
- Reference related issues or discussions; add screenshots or recordings for UI tweaks.
- Tag maintainers early if you need design or architectural guidance.
- For this fork, classify the PR as `contrib/*` or `fork/*` and complete the upstreamability checklist in the PR template.

## Helpful Resources

- 📚 Documentation: [docs.openmercato.com](https://docs.openmercato.com/)
- 🧠 Agents & architecture guide: [`AGENTS.md`](AGENTS.md)
- 🔀 Fork contribution workflow: [`docs/upstream-contribution-workflow.md`](docs/upstream-contribution-workflow.md)
- 🧾 Current fork divergence audit: [`docs/fork-divergence-audit.md`](docs/fork-divergence-audit.md)
- 💬 Community discussions and issues: [GitHub issues](https://github.com/open-mercato/open-mercato/issues)

Thanks for helping us build a more extensible, AI-ready operations platform!
