# Upstream Contribution Workflow for This Fork

This fork uses a dual-track model so we can keep shipping local work without polluting future contributions to Open Mercato.

## Branch Roles

- `upstream/develop` – external source of truth for regular contribution work
- local `develop` – tracks `upstream/develop`; never commit here directly
- `origin/develop` – mirror of `upstream/develop` in this fork, used as the collaboration base for future `contrib/*` branches
- `main` – delivery branch for fork-only work, deployment overlays, and local product decisions

## Branch Prefixes

- `contrib/*` – work that might become an upstream PR
- `fork/*` – intentionally fork-only work
- `sync/*` – short-lived branches for upstream sync or extraction work

Never mix `contrib/*` and `fork/*` logic in the same commit.

## Default Decision Rule

Start from `develop` whenever a change has even a plausible upstream value.

Use `fork/*` only when the change is clearly local, such as:

- environment-specific infrastructure
- domain or deployment configuration
- local business rules or branding
- temporary experiments that are not yet clean enough for upstream

If fork-only work later proves reusable, re-create it on a fresh `contrib/*` branch from `develop` instead of branching from `main`.

## Weekly Sync Routine

Run this before starting new `contrib/*` work and at least once a week while contribution branches are open:

```bash
git fetch upstream --prune
git checkout develop
git merge --ff-only upstream/develop
git push origin develop
```

Then rebase each open `contrib/*` branch:

```bash
git checkout contrib/<name>
git rebase develop
```

Rules:

- never merge `main` into `develop`
- prefer fast-forward updates for `develop`
- keep `origin/develop` aligned with `upstream/develop`

## Authoring Rules for `contrib/*`

- one logical topic per commit
- use conventional commit prefixes such as `feat(scope): ...`, `fix(scope): ...`, `chore(scope): ...`
- keep branches cherry-pickable onto a clean `develop`
- favor modules, extension points, and overlays over direct core patches
- confirm compliance with `BACKWARD_COMPATIBILITY.md` before changing contract surfaces
- for non-trivial work, update or create the relevant spec before opening a PR

## Strict Local Quality Gate

Run this full gate before proposing an upstream PR:

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

Also run `yarn test:integration` if the change touches:

- user-facing flows
- CRUD or API contracts
- generators
- module auto-discovery
- extension points, injections, or component replacement
- events, notifications, or event bridge behavior

## Upstreamability Checklist

Every `contrib/*` change should pass these questions before PR creation:

1. Does this change provide platform value beyond this fork?
2. Can it be built as a module, extension point, or provider package instead of a fork-only core patch?
3. Does it preserve all applicable contracts in `BACKWARD_COMPATIBILITY.md`?
4. Is the branch based on a fresh `develop` and isolated from fork-only history?
5. Are specs, docs, locales, generators, and tests updated where required?
6. Would this change still make sense if this fork disappeared tomorrow?

## Local Noise Hygiene

Keep machine-local state and ad-hoc screenshots out of contribution branches. For assets that are useful only on one workstation, prefer `.git/info/exclude` instead of repo-tracked ignores.

Current examples that must stay out of future `contrib/*` work:

- `.omc/`
- `.serena/`
- root-level exploratory screenshots such as `api-docs.png`, `dashboard.png`, `login-page.png`, and `settings.png`
