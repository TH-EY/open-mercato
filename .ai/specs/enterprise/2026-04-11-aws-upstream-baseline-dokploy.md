# AWS Upstream Baseline Environment (Dokploy)

## TLDR

**Key points:**
- Add a parallel AWS environment that deliberately avoids the current CloudFormation/ECS overlay and runs Open Mercato through Dokploy + the upstream `docker-compose.fullapp.yml` flow.
- Reuse the existing shared `they-lb` ALB, but give the baseline environment its own EC2 host, target group, listener rule, DNS record, secrets, and data volumes.
- Keep the Dokploy control plane and the Open Mercato app on the same EC2 host by reserving port `3000` for Dokploy and moving the app listener to `3001` via `APP_PORT=3001`.
- Keep the Git source clean by mirroring `upstream/develop` into a dedicated branch (`upstream-baseline`) and pointing the stable baseline at `TH-EY/open-mercato:upstream-baseline`.
- Add per-branch contribution previews on `preview-<slug>.om.they.dev`, each backed by its own isolated Docker Compose stack on the baseline host.

**Scope:**
- `infra/aws-upstream-baseline/README.md` — operator runbook for the new baseline environment
- `infra/aws-upstream-baseline/provision.sh` — idempotent AWS bootstrap script (EC2 + IAM + SG + TG + listener rule + Route53)
- `infra/aws-upstream-baseline/user-data.sh` — EC2 user-data installing Dokploy on Ubuntu 22.04
- `.github/workflows/sync-upstream-baseline.yml` — keeps a clean mirror branch aligned with `upstream/develop`
- `infra/aws-upstream-baseline/preview-common.sh` / `preview-upsert.sh` / `preview-destroy.sh` / `enable-preview-hostnames.sh` / `point-baseline-at-fork-mirror.sh` - operational scripts for stable-source pinning and branch preview lifecycle
- `.github/workflows/contrib-preview-upsert.yml` / `contrib-preview-destroy.yml` - automated branch preview lifecycle
- updates to deployment/contribution docs so the new baseline path is explicit and separated from the CloudFormation production path

**Constraints:**
- No CloudFormation, ECS, or target-sync Lambda in the new baseline path.
- No shared PostgreSQL / Redis / Meilisearch / storage with the existing production stack.
- The production CloudFormation stack remains the source of truth only for `openmercato.they.dev`.

---

## Overview

The repository currently deploys its production/demo AWS environment through a fork-only CloudFormation stack. That path is intentionally not upstream-like: it owns ECS services, shared-ALB integration glue, and other AWS-specific operational logic. This spec introduces a second environment whose job is the opposite: stay as close as possible to the upstream Open Mercato deployment story so feature teams can validate contributions without CloudFormation-specific drift.

The new environment runs on a dedicated EC2 host in the same VPC as the shared `they-lb` ALB. Dokploy is installed directly on that host. Dokploy then deploys Open Mercato from a clean upstream branch using the official `docker-compose.fullapp.yml` file. The app is exposed on host port `3001`, while Dokploy keeps its default port `3000` for the admin UI.

---

## Problem Statement

- `origin/develop` is a deployment branch with fork-only AWS overlay commits, so deploying it does not prove upstream parity.
- The CloudFormation/ECS path has already shown rollout instability caused by AWS-specific control-plane interactions, making it a poor baseline for upstream contribution confidence.
- Reusing the same database, cache, search, or storage would couple the baseline env to production state and invalidate test results.
- The current repository lacks a codified runbook and bootstrap automation for a clean upstream-style AWS environment.
- The current baseline ingress path forwards directly to host port `3001`, so branch previews need their own listener rules and target groups unless the host is later migrated to Traefik-based host routing.

---

## Proposed Solution

### Architecture

- **Control plane + app host:** one dedicated EC2 instance in the shared ALB VPC.
- **Host sizing:** use `t3.xlarge` as the default baseline host so Dokploy, the upstream image build, and the full compose stack can coexist without evicting the control plane during deploys.
- **Host storage:** provision the EC2 root volume at `50 GB gp3` so upstream image pulls/builds fit without manual disk rescue.
- **Ingress:** existing `they-lb` ALB, new target group + new host-header rule + new Route53 record.
- **Dokploy UI:** public/admin access on EC2 port `3000` (restricted by security group).
- **Open Mercato app:** deployed by Dokploy from `docker-compose.fullapp.yml`, exposed on host port `3001`, health checked on `/login`.
- **Data plane:** PostgreSQL, Redis, Meilisearch, and storage stay local to this host via Docker named volumes.
- **Git source:** dedicated mirror branch `upstream-baseline` synced from `upstream/develop`; stable baseline deploys from this fork-owned mirror.
- **Contribution previews:** each `contrib/*` branch gets a dedicated preview hostname, dedicated ALB listener rule, dedicated ALB target group, dedicated host port, and isolated Docker Compose state on the same EC2 host.

### Default naming

| Resource | Default |
| --- | --- |
| EC2 instance name | `openmercato-upstream-baseline-dokploy` |
| Security group | `openmercato-upstream-baseline-dokploy-sg` |
| IAM role/profile | `openmercato-upstream-baseline-ssm-role` |
| Target group | `openmercato-upstream-baseline-tg` |
| DNS hostname | `om.they.dev` |
| App host port | `3001` |

### Why port `3001`

Dokploy's official installation expects port `3000` to be available for its own UI. Running the baseline app on `3001` avoids a control-plane/data-plane collision while keeping the app reachable from the ALB.

### Git branch strategy

- `origin/develop` remains the fork deployment branch with overlay logic.
- `upstream-baseline` is a force-updated mirror of `upstream/develop`.
- The stable Dokploy baseline app tracks `upstream-baseline`, **never** `develop`.
- Every `contrib/*` branch starts from `upstream-baseline`, not from `develop`.
- Preview validation deploys the branch itself to `preview-<slug>.om.they.dev` and does not reuse `om.they.dev`.

---

## Architecture Details

### AWS bootstrap flow

1. Create or reuse an IAM instance profile with `AmazonSSMManagedInstanceCore`.
2. Create or reuse a security group allowing:
   - `80` / `443` from the internet
   - `3000` from explicit admin CIDRs
   - `3001` from the shared ALB security group only
   - preview port range `4100-4899` from the shared ALB security group
   - optional `22` from explicit SSH CIDRs
3. Launch an Ubuntu 22.04 EC2 instance in the ALB VPC public subnet with Dokploy user-data.
4. Create or reuse an ALB target group on port `3001` with health check path `/login`.
5. Register the EC2 instance into that target group.
6. Create or reuse a host-header listener rule for `om.they.dev`.
7. Upsert a Route53 alias record in `they.dev` pointing the hostname at the shared ALB.

### Dokploy application setup

1. Complete Dokploy first-login on `http://<public-ip>:3000`.
2. Create a Docker Compose app that points at:
   - repo: `https://github.com/open-mercato/open-mercato.git` **or** this fork's `upstream-baseline` branch
   - branch: `develop` or `upstream-baseline`
   - compose path: `docker-compose.fullapp.yml`
3. Set environment variables in Dokploy UI:
   - `APP_PORT=3001`
   - `APP_URL=https://om.they.dev`
   - `AUTH_SECRET`, `JWT_SECRET`, `TENANT_DATA_ENCRYPTION_KEY`
   - `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`
   - `MEILISEARCH_MASTER_KEY`
   - optional operational vars (`ADMIN_EMAIL`, `RESEND_API_KEY`, etc.)
5. Leave PostgreSQL / Redis / Meilisearch / storage isolated inside the compose stack via named volumes.

### Verification flow

- Bootstrap parity: app starts from a clean upstream source without fork overlay logic.
- Ingress parity: ALB host rule resolves only to the new EC2 target group; health check uses `/login`.
- Sync parity: mirror branch fast-forwards from upstream without repository-local deployment drift.
- Rollback: Dokploy rollback does not touch the CloudFormation production stack.

---

## API Contracts / Interfaces

### CLI contract — `infra/aws-upstream-baseline/provision.sh`

The bootstrap script is env-driven. Important inputs:

| Variable | Default |
| --- | --- |
| `AWS_REGION` | `eu-west-2` |
| `VPC_ID` | `vpc-20252849` |
| `HOSTED_ZONE_ID` | `Z05995411RZM1GDPTHOZ6` (`they.dev`) |
| `BASELINE_HOSTNAME` | `om.they.dev` |
| `INSTANCE_NAME` | `openmercato-upstream-baseline-dokploy` |
| `APP_PORT` | `3001` |
| `INSTANCE_TYPE` | `t3.xlarge` |
| `ALB_ARN` | shared `they-lb` ARN |
| `ALB_SG_ID` | shared `they-lb` security group |
| `SSH_CIDR` | empty (optional) |
| `DOKPLOY_ADMIN_CIDRS` | caller public IP/32 by default |

Outputs:
- EC2 instance id, public IP, private IP
- target group ARN
- listener rule ARN / priority
- reminder to finish Dokploy UI bootstrap

### GitHub Actions contract — `sync-upstream-baseline.yml`

- Trigger: manual + nightly schedule
- Effect: force-update `origin/upstream-baseline` to match `upstream/develop` exactly
- Guarantee: baseline deployments never consume the fork-only `develop` branch accidentally

---

## Risks & Impact Review

| Risk | Severity | Mitigation |
| --- | --- | --- |
| Dokploy admin UI on port `3000` exposed too broadly | High | restrict `3000` ingress to explicit admin CIDRs only; prefer SSM / VPN later |
| Baseline env accidentally points at `develop` overlay branch | High | create and document the `upstream-baseline` mirror branch; reference it everywhere |
| ALB health check fails because Dokploy app not yet configured | Medium | bootstrap EC2 + Dokploy first, then deploy compose app, then verify target health |
| Single-host local backing services reduce HA | Medium | accepted for parity-first validation env; production remains on CloudFormation stack |
| Docker Compose drift from upstream docs | Medium | always point at upstream compose file and minimize local overrides to env-only changes |

---

## Test Plan

1. Run `infra/aws-upstream-baseline/provision.sh` in a dry AWS bootstrap pass and verify the expected resources exist.
2. Complete Dokploy setup and deploy the baseline app from `upstream-baseline`.
3. Confirm `https://om.they.dev/login` returns HTTP 200 through `they-lb`.
4. Run `node ./scripts/smoke-auth-dashboard.mjs` against the baseline URL with baseline credentials.
5. Trigger `sync-upstream-baseline.yml`, verify the branch fast-forwards, and redeploy `om.they.dev` from the mirror branch.
6. Push a temporary `contrib/*` branch, let `contrib-preview-upsert.yml` deploy `preview-<slug>.om.they.dev`, and confirm no CloudFormation assets were touched.
7. Delete the `contrib/*` branch and verify `contrib-preview-destroy.yml` tears down the preview stack, target group, and listener rule.

---

## Final Compliance Report

- Keeps fork-only CloudFormation production path intact.
- Adds a separate upstream-parity path with minimal AWS-specific behavior.
- Avoids changing public platform APIs or module contracts.
- Documents the operational split clearly so future contribution work can target upstream-first validation.

---

## Changelog

- **2026-04-11** — Created spec for a Dokploy-based upstream baseline environment on AWS using the shared ALB and a clean upstream mirror branch.
- **2026-04-12** — Baseline hostname switched from `upstream-baseline.they.dev` to `om.they.dev`; ALB rule, Route53 alias, and runtime `APP_URL` were updated in-place.
- **2026-04-12** — Dokploy labels were renamed from `Upstream Baseline` to `OM Baseline`, and the baseline smoke helper was updated to default to `https://om.they.dev`.
- **2026-04-12** — Added a baseline ALB health helper that defaults to `om.they.dev` and the live target group ARN for fast diagnostics.
- **2026-04-12** — Standardized the stable baseline source on `TH-EY/open-mercato:upstream-baseline` and added automated per-branch preview lifecycle support for `contrib/*`.
- **2026-04-11** — Live environment provisioned and validated at `om.they.dev`; first fresh-host image build required extra time because the upstream runtime image recursively `chown`s `/app` during build.
