# Open Mercato AWS Deployment - Changelog

## Session: 2026-04-12

### What was done

- Reworked the upstream contribution workflow around `upstream-baseline` as the only valid base for `contrib/*`
- Added automated per-branch preview deployment support for `contrib/*`
- Added preview lifecycle scripts for branch upsert, destroy, baseline source pinning, and preview hostname enablement
- Added GitHub Actions workflows to deploy previews on push and destroy them on branch delete
- Updated contribution and QA documentation so `om.they.dev` is treated as the stable upstream baseline, not as a temporary feature sandbox
- Added the operational path to point the live baseline Dokploy compose source at `TH-EY/open-mercato:upstream-baseline`
- Added the operational path to enable `*.om.they.dev` wildcard certificate and wildcard DNS for branch previews

### Files

| File | Purpose |
|------|---------|
| `.github/workflows/contrib-preview-upsert.yml` | Deploy or update isolated preview envs for `contrib/*` branches |
| `.github/workflows/contrib-preview-destroy.yml` | Destroy isolated preview envs when `contrib/*` branches are deleted |
| `infra/aws-upstream-baseline/preview-common.sh` | Shared preview deployment helpers |
| `infra/aws-upstream-baseline/preview-upsert.sh` | Upsert a branch preview stack and its ALB routing |
| `infra/aws-upstream-baseline/preview-destroy.sh` | Destroy a branch preview stack and its ALB routing |
| `infra/aws-upstream-baseline/enable-preview-hostnames.sh` | Enable wildcard cert, wildcard DNS, and preview port ingress |
| `infra/aws-upstream-baseline/point-baseline-at-fork-mirror.sh` | Repoint live baseline source to `TH-EY/open-mercato:upstream-baseline` |
| `docs/upstream-contribution-workflow.md` | Updated contribution workflow using `upstream-baseline` and per-branch previews |
| `CONTRIBUTING.md` | Updated contribution entrypoint to match the new branch model |
| `.github/QA-DEPLOYMENT.md` | Updated QA docs to make branch previews the default path |
| `infra/aws-upstream-baseline/README.md` | Updated operator runbook for baseline + preview flow |

## Session: 2026-04-11

### What was done

- Added a parallel **upstream-baseline** AWS runbook based on Dokploy + Docker Compose instead of CloudFormation/ECS
- Added an idempotent AWS bootstrap script for the baseline host, ingress, and DNS
- Added a dedicated `upstream-baseline` branch sync workflow that mirrors `upstream/develop`
- Explicitly separated CloudFormation production documentation from the new upstream-parity environment
- Raised the upstream-baseline host defaults to `t3.xlarge` + `50 GB gp3` after the first live Dokploy deployment exhausted the original `t3.medium` / 8 GB root-disk sizing
- Completed a live rollout at `om.they.dev` and smoke-validated login, dashboard access, global search, attachment upload, and ALB target health
- Renamed the Dokploy project/service labels from `Upstream Baseline` to `OM Baseline` and added a baseline smoke helper that defaults to `https://om.they.dev`
- Added an ALB health helper that checks DNS, target health, and `/login` response for the OM baseline host

### Files

| File | Purpose |
|------|---------|
| `infra/aws-upstream-baseline/README.md` | Operator runbook for the new Dokploy baseline environment |
| `infra/aws-upstream-baseline/provision.sh` | AWS bootstrap script for EC2 + SG + TG + listener rule + Route53 |
| `infra/aws-upstream-baseline/user-data.sh` | Dokploy installation user-data for the EC2 host |
| `infra/aws-upstream-baseline/smoke.sh` | Convenience smoke wrapper defaulting to `https://om.they.dev` |
| `infra/aws-upstream-baseline/check-health.sh` | Quick ALB/DNS/HTTP health diagnostic for the OM baseline environment |
| `.github/workflows/sync-upstream-baseline.yml` | Mirrors `upstream/develop` into `origin/upstream-baseline` |
| `.ai/specs/enterprise/2026-04-11-aws-upstream-baseline-dokploy.md` | Implementation spec for the new environment |
