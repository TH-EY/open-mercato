# AWS Upstream Baseline Environment

This runbook manages the upstream-parity AWS path that intentionally stays outside the CloudFormation/ECS stack used by `openmercato.they.dev`.

## Purpose

The goal is to validate Open Mercato work against an environment that keeps upstream-like runtime topology while carrying a reusable seeded QA dataset cloned from the old CloudFormation stack:

- separate EC2 host in the shared `they-lb` VPC
- Docker Compose stack using `docker-compose.fullapp.yml`
- separate target groups, listener rules, domains, volumes, and secrets from the CloudFormation path
- clean Git source based on `upstream-baseline`, not on the fork deployment branch
- seeded baseline data restored from the old CloudFormation PostgreSQL database via logical dump and restore
- reusable baseline seed dump for preview cloning

## Environment mapping

- `https://openmercato.they.dev`
  - source: `TH-EY/open-mercato:develop`
  - runtime: CloudFormation + ECS
- `https://om.they.dev`
  - source: `TH-EY/open-mercato:upstream-baseline`
  - runtime: Dokploy-managed Docker Compose
  - role: seeded QA baseline
- `https://preview-<slug>.om.they.dev`
  - source: `TH-EY/open-mercato:contrib/<topic>`
  - runtime: isolated Docker Compose preview stack on the same host
  - data source: logical clone of the seeded `om.they.dev` baseline database

## Current baseline architecture

- shared ALB: `they-lb`
- baseline host: `om.they.dev`
- Dokploy UI: `http://<ec2-public-ip>:3000`
- baseline app port: `3001`
- preview app ports: `4100-4899`
- EC2 instance type: `t3.xlarge`
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

### Restore the seeded QA baseline from the old CloudFormation database

```bash
SMOKE_TEST_EMAIL=superadmin@acme.com \
SMOKE_TEST_PASSWORD='<known-password>' \
./infra/aws-upstream-baseline/restore-baseline-from-cloudformation.sh
```

This operator flow:

- reads the old CloudFormation database URL and encryption key from Secrets Manager
- temporarily authorizes the preview host security group to reach the old RDS instance on port `5432`
- stops writes on `om.they.dev`
- backs up the current baseline database and baseline `.env`
- restores a logical dump from the old CloudFormation database into the Compose-managed baseline Postgres
- sets both `TENANT_DATA_ENCRYPTION_KEY` and `TENANT_DATA_ENCRYPTION_FALLBACK_KEY` on the baseline to the old encryption key
- brings the baseline app back up on the same Dokploy + ALB topology
- exports a reusable baseline seed dump for branch previews

### Export the current seeded baseline dump manually

```bash
./infra/aws-upstream-baseline/export-baseline-seed-dump.sh
```

This writes:

- dump: `/opt/openmercato-baseline-seed/baseline-seed.dump`
- metadata: `/opt/openmercato-baseline-seed/baseline-seed.json`

### Upsert a branch preview manually

```bash
./infra/aws-upstream-baseline/preview-upsert.sh contrib/my-feature
```

This:

- clones or updates that branch on the preview host
- creates a fresh isolated Postgres / Redis / Meilisearch / storage set for the branch
- restores the reusable seeded baseline dump into the branch Postgres before app startup
- carries forward the baseline tenant-encryption secrets needed to read seeded data
- builds and runs an isolated compose stack
- creates or updates the ALB target group and listener rule
- waits for health and HTTP readiness

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
- reuse the production PostgreSQL / Redis / Meilisearch / storage as live shared infrastructure
- point at the fork deployment branch `develop`
