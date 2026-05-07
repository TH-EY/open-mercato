# AWS Upstream Baseline Environment

This runbook manages the upstream-parity AWS path that intentionally stays outside the CloudFormation/ECS stack used by `openmercato.they.dev`.

For the full developer/operator map of production, baseline, existing `*.om.they.dev` previews, and CloudFormation/ECS previews under `*.openmercato.they.dev`, see [`../OPEN_MERCATO_AWS_ENVIRONMENTS.md`](../OPEN_MERCATO_AWS_ENVIRONMENTS.md).

## Purpose

The goal is to validate Open Mercato work against an environment that stays as close as possible to upstream runtime expectations:

- separate EC2 host in the shared `they-lb` VPC
- Docker Compose stack using `docker-compose.fullapp.yml`
- separate target groups, listener rules, domains, volumes, and secrets from the CloudFormation path
- clean Git source based on `upstream-baseline`, not on the fork deployment branch

## Environment mapping

- `https://openmercato.they.dev`
  - source: `TH-EY/open-mercato:develop`
  - runtime: CloudFormation + ECS
- `https://om.they.dev`
  - source: `TH-EY/open-mercato:upstream-baseline`
  - runtime: Dokploy-managed Docker Compose
- `https://preview-<slug>.om.they.dev`
  - source: `TH-EY/open-mercato:contrib/<topic>`
  - runtime: isolated Docker Compose preview stack on the same host
- `https://rhodes.om.they.dev`
  - source: `TH-EY/open-mercato:fork/demo-rhodes`
  - runtime: persistent client demo Docker Compose stack on the same host
- `https://preview-<slug>.openmercato.they.dev`
  - source: `TH-EY/open-mercato:contrib/<topic>`
  - runtime: CloudFormation/ECS preview stack sharing production data from `openmercato.they.dev`
  - runbook: `../OPEN_MERCATO_AWS_ENVIRONMENTS.md`

## Current baseline architecture

- shared ALB: `they-lb`
- baseline host: `om.they.dev`
- Dokploy UI: `http://<ec2-public-ip>:3000`
- baseline app port: `3001`
- preview app ports: `4100-4899`
- EC2 instance type: `t3.large`
- EC2 root volume: `50 GB gp3`
- baseline health check: `GET /login`

## Required Git source

The baseline app must point to:

- repo: `https://github.com/TH-EY/open-mercato.git`
- branch: `upstream-baseline`
- compose path: `docker-compose.fullapp.yml`

Do not point the baseline app at:

- `TH-EY/open-mercato:develop`
- `open-mercato/open-mercato:develop`

Direct upstream was useful for the first bootstrap, but the long-term contribution workflow needs a fork-owned mirror branch.

## Key scripts

### Baseline host bootstrap

```bash
./infra/aws-upstream-baseline/provision.sh
```

Creates or updates:

- EC2 host
- instance profile
- security group
- baseline target group
- baseline listener rule
- baseline Route53 alias

### Point baseline at the fork mirror

```bash
./infra/aws-upstream-baseline/point-baseline-at-fork-mirror.sh
```

Updates the Dokploy compose source to:

- `https://github.com/TH-EY/open-mercato.git`
- branch `upstream-baseline`

### Enable preview hostnames

```bash
./infra/aws-upstream-baseline/enable-preview-hostnames.sh
```

Ensures:

- security-group ingress from ALB to preview port range `4100-4899`
- ACM certificate for `*.om.they.dev`
- wildcard Route53 alias `*.om.they.dev`
- ALB listener attachment for the preview certificate

### Upsert a branch preview manually

```bash
./infra/aws-upstream-baseline/preview-upsert.sh contrib/my-feature
```

This:

- clones or updates that branch on the preview host
- builds and runs an isolated compose stack
- reconciles the smoke admin inside restored/seeded tenant data when `SMOKE_TEST_TENANT_ID` is provided
- creates or updates the ALB target group and listener rule
- waits for health and HTTP readiness

### Upsert a persistent client demo manually

Use demos for customer environments that must survive redeploys. Unlike `contrib/*` previews, demo updates do not run `docker compose down --volumes`; the PostgreSQL, Redis, Meilisearch, init marker, and attachment volumes are preserved.

```bash
./infra/aws-upstream-baseline/demo-upsert.sh rhodes fork/demo-rhodes
```

This creates or updates:

- hostname `rhodes.om.they.dev`
- checkout under `/opt/openmercato-demos/rhodes`
- Docker Compose project `demo-rhodes`
- isolated Docker network and named volumes for app data
- one ALB target group and listener rule for the demo hostname

Set `DEMO_BRANCH` or pass the optional second argument to deploy a specific branch. Set `DEMO_ADMIN_EMAIL`, `DEMO_ADMIN_PASSWORD`, and `DEMO_ADMIN_TENANT_ID` to reconcile a known demo admin after startup.

By default, manual demos reuse the existing `open-mercato/app:upstream-baseline` image and run Compose with `--no-build` to avoid long source builds on the shared Dokploy host. Set `DEMO_REUSE_BASELINE_IMAGE=false` only when a demo must build a distinct branch image.

For Rhodes, pushing `fork/demo-rhodes` triggers `.github/workflows/demo-rhodes-deploy.yml`, which builds the branch image in GitHub Actions, pushes it to ECR, and deploys it to `rhodes.om.they.dev` through this same `demo-upsert.sh` path using `DEMO_APP_IMAGE` and `--no-build` on the Dokploy host.

### Stop or delete a persistent client demo manually

```bash
./infra/aws-upstream-baseline/demo-destroy.sh rhodes
```

Without `--delete-data`, this stops containers and removes ALB routing, but keeps the workdir and Docker volumes so the demo can be restored later. To intentionally remove all demo data:

```bash
./infra/aws-upstream-baseline/demo-destroy.sh rhodes --delete-data
```

### Reconcile smoke admin after DB restore

When a restored dataset does not contain the expected smoke admin user, or when a target tenant is missing seeded role ACLs, run:

```bash
./infra/aws-upstream-baseline/reconcile-smoke-admin.sh \
  --workdir /path/to/checkout \
  --project-name preview-my-branch \
  --env-file /path/to/checkout/.env \
  --compose-file /path/to/checkout/docker-compose.fullapp.yml \
  --email "$SMOKE_TEST_EMAIL" \
  --password "$SMOKE_TEST_PASSWORD" \
  --tenant-id "$SMOKE_TEST_TENANT_ID"
```

What it does:

- ensures built-in roles exist for the tenant
- creates the smoke admin user inside the restored tenant when missing
- reruns `auth setup` against that tenant/user so default role ACLs are restored
- prints the tenant user list for verification

This is safe to rerun and is invoked automatically by preview/demo upsert when the admin email, password, and tenant ID are provided.

### Destroy a branch preview manually

```bash
./infra/aws-upstream-baseline/preview-destroy.sh contrib/my-feature
```

This:

- stops and removes the branch stack on the preview host
- deletes the ALB listener rule
- deletes the ALB target group

### Baseline health helper

```bash
./infra/aws-upstream-baseline/check-health.sh
```

### Baseline smoke helper

```bash
SMOKE_TEST_EMAIL=ops@they.dev \
SMOKE_TEST_PASSWORD='BaselineAdmin!2026' \
./infra/aws-upstream-baseline/smoke.sh
```

## GitHub workflows

- `.github/workflows/sync-upstream-baseline.yml`
  - force-syncs `origin/upstream-baseline` from `upstream/develop`
- `.github/workflows/contrib-preview-upsert.yml`
  - deploys or updates a preview on every push to `contrib/*`
- `.github/workflows/contrib-preview-destroy.yml`
  - destroys the preview when the branch is deleted or when triggered manually
- `.github/workflows/demo-rhodes-deploy.yml`
  - builds and deploys `fork/demo-rhodes` to `https://rhodes.om.they.dev` on every push

## Notes on ingress

The current baseline host still uses direct ALB forwarding to host ports instead of routing `om.they.dev` through Dokploy's Traefik layer.

Because of that, branch previews currently use:

- wildcard DNS + wildcard certificate for `*.om.they.dev`
- one ALB listener rule and one target group per preview host

This keeps the runtime upstream-like while avoiding a risky mid-flight ingress migration on the baseline host.

## Non-goals

This path must not:

- use CloudFormation for the baseline or preview envs
- use ECS for the baseline or preview envs
- reuse the production PostgreSQL / Redis / Meilisearch / storage
- point at the fork deployment branch `develop`
