# Contributing to Open Mercato

We’re excited to collaborate with folks building on top of Open Mercato. This guide explains how we organize releases, structure branches, and prepare pull requests so changes land smoothly.

## Branch Model

- `main` - release-ready code. Every commit is tagged and deployable. Keep PRs targeting `main` limited to hotfixes or release prep approved by maintainers.
- `develop` - nightly builds and upcoming release work.
- Topic branches - create a dedicated branch per change using the format `feat/<concise-feature-name>` (for example `feat/customer-export`). Use other prefixes when appropriate (`fix/`, `chore/`, `docs/`).

## Fork Workflow for This Repository

This fork uses a split model so we can keep shipping fork-specific work while preparing clean future contributions to Open Mercato.

- `develop` in this fork is the deployment branch for `https://openmercato.they.dev`. It may contain fork-only overlay work.
- `upstream-baseline` is a clean mirror of `upstream/develop` and is the only valid base for future upstream contributions.
- `main` is a mirror of `upstream/main` for release tracking only.
- Branch prefixes in this fork:
  - `contrib/*` - potential upstream contributions, always branched from `upstream-baseline`
  - `fork/*` - fork-only work that is allowed to depend on local infrastructure or business decisions
  - `sync/*` - short-lived cherry-pick or sync branches used to move already-clean `contrib/*` commits into `develop`
- Never develop directly on `develop`, `upstream-baseline`, or `main`.
- Never merge `develop` into `contrib/*`.
- Never point the upstream baseline environment at `develop`.
- `om.they.dev` now serves as a seeded QA baseline on top of the upstream-like Dokploy runtime; preview branches still stay isolated from it.

See [`docs/upstream-contribution-workflow.md`](docs/upstream-contribution-workflow.md) for the operational workflow, preview deployment flow, and strict local quality gate.

Important preview note:

- `upstream-baseline` intentionally stays a clean mirror of upstream
- pure `contrib/*` branches cut from that base do not carry fork workflow files
- preview environments are therefore deployed from the base branch workflow via PR updates or explicit manual dispatch

## Working on Features

- Branch from the correct base:
  - use `upstream-baseline` for `contrib/*`
  - use `develop` for `fork/*`
- Keep commits scoped and descriptive. Squash locally if it clarifies the story.
- Follow module conventions from [`AGENTS.md`](AGENTS.md) and prefer the `packages/` workspace for new code.
- Document user-facing copy in the locale dictionaries and keep translations in sync.
- In this fork, choose the branch family before writing code:
  - use `contrib/*` for anything that could plausibly be proposed upstream
  - use `fork/*` only for intentionally local work
- Keep `contrib/*` branches cherry-pickable onto a clean `upstream-baseline`: one logical topic per commit, no mixed fork-only and upstream-candidate changes in the same commit.

### Spec Driven Development

Before implementing new features or making significant changes, check for an existing spec in `.ai/specs/`:

1. Check for a spec related to your feature
2. Create or update it when needed
3. Maintain the changelog entry
4. Update [`.ai/specs/README.md`](.ai/specs/README.md) when adding a new spec

See [`.ai/specs/README.md`](.ai/specs/README.md) for the full specification directory and [`.ai/specs/AGENTS.md`](.ai/specs/AGENTS.md) for detailed guidelines.

### Syncing with Upstream

Before starting new `contrib/*` work, and at least once a week for active branches:

1. `git fetch origin --prune`
2. `git fetch upstream --prune`
3. refresh local `upstream-baseline` from `origin/upstream-baseline`
4. branch `contrib/*` from that clean base
5. rebase open `contrib/*` branches onto the refreshed `origin/upstream-baseline`

Do not merge fork-only history into `upstream-baseline`. If you need functionality that only exists on the fork track, either extract a clean version for `contrib/*` or classify the work as fork-only.

### Strict Local Quality Gate for `contrib/*`

Before opening an upstream PR from this fork, run:

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

Also run `yarn test:integration` whenever the change touches UI flows, CRUD/API contracts, generators, auto-discovery, extension points, injection, component replacement, or event delivery.

## Pull Requests

- Open upstream PRs against `open-mercato/open-mercato:develop`.
- Describe the user impact, architectural notes, and testing performed.
- Ensure the branch rebases cleanly and CI is green before requesting review.
- Reference related issues or discussions; add screenshots or recordings for UI tweaks.
- For this fork, classify the work correctly as `contrib/*`, `fork/*`, or `sync/*` and complete the upstreamability checklist in the PR template.

## Helpful Resources

- Documentation: [docs.openmercato.com](https://docs.openmercato.com/)
- Agents & architecture guide: [`AGENTS.md`](AGENTS.md)
- Fork contribution workflow: [`docs/upstream-contribution-workflow.md`](docs/upstream-contribution-workflow.md)
- Current fork divergence audit: [`docs/fork-divergence-audit.md`](docs/fork-divergence-audit.md)
- Community discussions and issues: [GitHub issues](https://github.com/open-mercato/open-mercato/issues)

Thanks for helping us build a more extensible, AI-ready operations platform!
