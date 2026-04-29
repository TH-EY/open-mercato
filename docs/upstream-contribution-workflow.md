# Upstream Contribution Workflow for This Fork

This fork now uses a split model:

- `develop` stays the fork deployment branch for `https://openmercato.they.dev`
- `upstream-baseline` is the only clean base for upstream-candidate work and for `https://om.they.dev`

For concrete AWS environment details, target groups, host paths, deploy workflows, and preview mechanics, see [`../infra/OPEN_MERCATO_AWS_ENVIRONMENTS.md`](../infra/OPEN_MERCATO_AWS_ENVIRONMENTS.md).

## Branch Roles

- `upstream/develop` - external source of truth for upstream contribution work
- `upstream/main` - upstream release branch
- `origin/upstream-baseline` - force-synced mirror of `upstream/develop`; no manual commits
- `origin/develop` - fork deployment branch for `openmercato.they.dev`; may include fork-only overlay
- `origin/main` - mirror of `upstream/main`
- `contrib/*` - upstream-candidate branches; always branched from `upstream-baseline`
- `fork/*` - intentionally local work; always branched from `develop`
- `sync/*` - short-lived branches for cherry-picks from `contrib/*` into `develop` or for sync/extraction work

Never mix `contrib/*` and `fork/*` logic in the same commit.

## Environment Mapping

- `https://openmercato.they.dev`
  - source: `TH-EY/open-mercato:develop`
  - deploy: `.github/workflows/deploy-aws.yml`
  - runtime: CloudFormation + ECS
- `https://om.they.dev`
  - source: `TH-EY/open-mercato:upstream-baseline`
  - deploy: Dokploy + `docker-compose.fullapp.yml`
  - role: stable upstream baseline
- `https://preview-<slug>.om.they.dev`
  - source: `TH-EY/open-mercato:contrib/<topic>`
  - deploy: preview automation from `.github/workflows/contrib-preview-upsert.yml`
  - runtime: isolated Docker Compose stack on the Dokploy host, with its own DB / Redis / Meilisearch / storage

Important GitHub Actions note:

- `upstream-baseline` intentionally mirrors upstream and does not carry fork workflow files
- pure `contrib/*` branches cut from `upstream-baseline` therefore cannot rely only on push-triggered workflow discovery
- preview deployment must also be executable from the base branch via `pull_request_target` or explicit `workflow_dispatch`

## Source of Truth Rules

- Never start `contrib/*` from `develop`
- Never merge `develop` into `contrib/*`
- Never point `om.they.dev` at `develop`
- Never put fork-only paths into `contrib/*`
- If a branch stops being upstream-friendly, close it and recreate it as `fork/*`

## Sync Routine

Run this before starting new `contrib/*` work and at least once a week:

```bash
git fetch origin --prune
git fetch upstream --prune
git checkout upstream-baseline
git reset --hard origin/upstream-baseline
```

The mirror branch is maintained by:

```bash
.github/workflows/sync-upstream-baseline.yml
```

For the fork deployment branch, keep the old sync routine:

```bash
git fetch upstream --prune
git checkout develop
git merge upstream/develop
git push origin develop
```

Do not merge fork-only history back into `upstream-baseline`.

## Golden Path for Every Upstream Contribution

### 1. Start the branch

```bash
git fetch origin --prune
git fetch upstream --prune
git checkout upstream-baseline
git reset --hard origin/upstream-baseline
git checkout -b contrib/<topic>
```

### 2. Implement the change

- For non-trivial work, create or update the relevant spec in `.ai/specs/`
- Follow `AGENTS.md`, `BACKWARD_COMPATIBILITY.md`, the PR template, and the CLA
- Keep commits cherry-pickable and scoped to one logical topic
- Prefer modules, extension points, and provider packages over fork-only patches

### 3. Run the local gate

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

Also run:

```bash
yarn test:integration
```

for UI flows, CRUD/API contracts, generators, auto-discovery, extension points, injections, component replacement, events, notifications, or event bridge changes.

### 4. Push and get a preview

```bash
git push origin contrib/<topic>
```

Then either:

- update or open a PR, which triggers preview deployment from the base branch workflow
- or run a manual `workflow_dispatch` of `contrib-preview-upsert.yml`

That triggers:

```bash
.github/workflows/contrib-preview-upsert.yml
```

The workflow deploys an isolated preview stack for that branch to:

```text
https://preview-<slug>.om.they.dev
```

The workflow summary always includes the preview URL. If there is an open same-repo PR for the branch, the workflow also posts or updates a comment with the preview link.

### 5. Open the upstream PR

Open the PR from:

- head: `TH-EY/open-mercato:contrib/<topic>`
- base: `open-mercato/open-mercato:develop`

The PR must include:

- testing summary
- spec path
- CLA acknowledgement
- backward compatibility confirmation
- integration coverage or a reason why it is not required

### 6. Keep the branch current

```bash
git fetch origin --prune
git fetch upstream --prune
git checkout contrib/<topic>
git rebase origin/upstream-baseline
git push --force-with-lease
```

Each PR update or manual preview dispatch updates the preview environment for that branch.

### 7. After merge upstream

1. Wait for `origin/upstream-baseline` to sync from upstream
2. Let baseline redeploy or manually redeploy `om.they.dev`
3. Verify the feature works on `https://om.they.dev`
4. Delete the `contrib/*` branch
5. Branch deletion or PR close triggers:

```bash
.github/workflows/contrib-preview-destroy.yml
```

which tears down the preview environment and its ALB routing resources

## Exception Path: local AWS before upstream merge

If a feature must land on `openmercato.they.dev` before upstream merges it:

```bash
git checkout develop
git checkout -b sync/<topic>-to-develop
git cherry-pick <commit-from-contrib>
```

Only the `sync/*` branch is allowed to flow into `develop`.

Do not merge `contrib/*` directly into `develop`.

This keeps:

- `contrib/*` clean for upstream
- `develop` available for immediate local deployment needs

## CI Guardrail

A `fork-only-guard` job in CI checks `contrib/*` branches against `.github/fork-only-paths.txt`.

If a contrib branch contains fork-only files, CI fails.

## Local Noise Hygiene

Keep machine-local state and ad-hoc screenshots out of contribution branches.

Current examples that must stay out of `contrib/*`:

- `.omc/`
- `.serena/`
- exploratory screenshots and temporary local exports

## Upstreamability Checklist

Every `contrib/*` change should pass these questions before PR creation:

1. Does it provide platform value beyond this fork?
2. Can it be built as a module, extension point, or provider package instead of a local patch?
3. Does it preserve all touched contract surfaces from `BACKWARD_COMPATIBILITY.md`?
4. Is it based on fresh `upstream-baseline`, without fork-only history?
5. Are specs, docs, locales, generators, and tests updated where required?
6. Would the change still make sense if this fork disappeared tomorrow?
