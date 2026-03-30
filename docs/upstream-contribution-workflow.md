# Upstream Contribution Workflow for This Fork

This fork uses a dual-track model so we can keep shipping local work without polluting future contributions to Open Mercato.

## Branch Roles

- `upstream/develop` - external source of truth for regular contribution work
- `upstream/main` - upstream release branch (only gets release merges)
- `origin/develop` - **deployment branch**: `upstream/develop` + fork-only overlay (infra, deploy, docs)
- `origin/main` - pure mirror of `upstream/main` (release tracking only, not used for deployment)
- `contrib/*` - upstream-candidate features, based on `develop`
- `fork/*` - intentionally fork-only work (infra, deploy config, domain setup)
- `sync/*` - short-lived branches for upstream sync or extraction work

Never mix `contrib/*` and `fork/*` logic in the same commit.

## Default Decision Rule

Start from `develop` whenever a change has even a plausible upstream value.

Use `fork/*` only when the change is clearly local, such as:

- environment-specific infrastructure
- domain or deployment configuration
- local business rules or branding
- temporary experiments that are not yet clean enough for upstream

If fork-only work later proves reusable, re-create it on a fresh `contrib/*` branch from `develop` instead of branching from `fork/*` history.

## Develop Sync (weekly + before each deploy)

This is the primary sync routine. Run before starting new `contrib/*` work, before deploying, and at least once a week:

```bash
git fetch upstream --prune
git checkout develop
git merge upstream/develop
git push origin develop
```

Because fork-only files are purely additive (they don't exist in upstream), this merge is almost always conflict-free. Git merges the upstream changes into develop while preserving the fork-only overlay commits.

Then rebase each open `contrib/*` branch:

```bash
git checkout contrib/<name>
git rebase develop
```

Rules:

- never merge `main` into `develop`
- keep `origin/develop` as close to `upstream/develop` as possible (plus fork-only overlay)
- `develop` is the deployment branch - deploy from here

## Main Branch Sync (release tracking only)

Run periodically to keep the release mirror current:

```bash
git fetch upstream --prune
git checkout main
git merge --ff-only upstream/main
git push origin main
```

Main is NOT used for deployment - it only tracks upstream releases for reference.

## Pre-Upstream Deployment

When a `contrib/*` feature must be deployed before upstream accepts it:

1. Merge `contrib/feature` into `develop` (the deployment branch)
2. Deploy from `develop` via `workflow_dispatch`
3. Simultaneously PR the same branch to `upstream/develop`
4. When upstream merges, the next develop sync reconciles automatically (git recognizes identical changes from both sides)
5. The `contrib/*` branch can then be deleted

## Deployment

Production deployment runs from the `develop` branch via GitHub Actions (`deploy-aws.yml`):

1. Trigger `workflow_dispatch` on `develop` branch
2. The workflow builds an ARM64 Docker image and pushes to ECR
3. ECS web and worker services are updated with the new image
4. The workflow enforces that only `develop` can be deployed

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

## CI Guardrail

A `fork-only-guard` job in CI automatically checks `contrib/*` branches against `.github/fork-only-paths.txt`. If a contrib branch contains fork-only files (infra, deploy workflows, fork docs), CI will fail. This prevents accidental upstream pollution.

## Local Noise Hygiene

Keep machine-local state and ad-hoc screenshots out of contribution branches. For assets that are useful only on one workstation, prefer `.git/info/exclude` instead of repo-tracked ignores.

Current examples that must stay out of future `contrib/*` work:

- `.omc/`
- `.serena/`
- root-level exploratory screenshots such as `api-docs.png`, `dashboard.png`, `login-page.png`, and `settings.png`
