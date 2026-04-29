# QA Deployment Guide

This guide explains the current QA and preview options for this fork.

## Overview

There are now three different deployment paths:

1. Per-branch contrib previews on `preview-<slug>.om.they.dev`
2. Trusted CloudFormation/ECS previews on `preview-<slug>.openmercato.they.dev`
3. Legacy shared QA slots (`qa1` / `qa2`)

Use isolated `*.om.they.dev` per-branch previews for ordinary upstream-candidate work. Use CloudFormation/ECS previews only when you intentionally need to test against the live `openmercato.they.dev` tenant data. Use shared slots only for older fork workflows that still depend on the preview Docker image flow.

## Per-branch contrib previews

A branch preview is created automatically when you push to a branch named:

```text
contrib/<topic>
```

The workflow responsible is:

```text
.github/workflows/contrib-preview-upsert.yml
```

### What it does

- deploys the exact `contrib/*` branch to the Dokploy host used by the upstream baseline environment
- runs the standard `docker-compose.fullapp.yml` stack
- creates isolated PostgreSQL / Redis / Meilisearch / storage state for that branch
- creates or updates a dedicated ALB target group and listener rule for the preview host
- smoke-tests the deployed preview URL

### Preview URL format

```text
https://preview-<slug>.om.they.dev
```

The exact URL is written to the workflow summary. If there is an open same-repo PR for that branch, the workflow also comments the URL on the PR.

### Lifecycle

- every push to the same `contrib/*` branch updates the same preview environment
- deleting the branch destroys the preview environment automatically via:

```text
.github/workflows/contrib-preview-destroy.yml
```

- you can also destroy a preview manually with the `workflow_dispatch` input on that cleanup workflow

### Notes

- branch previews are meant for upstream contribution validation
- branch previews are isolated from `om.they.dev`
- branch previews are isolated from `openmercato.they.dev`
- branch previews use the same compose topology as the upstream baseline, not the CloudFormation/ECS stack

## Trusted CloudFormation/ECS previews

Manual CloudFormation/ECS previews are available for trusted `contrib/*` branches:

```text
.github/workflows/cf-preview-upsert.yml
```

Preview URL format:

```text
https://preview-<slug>.openmercato.they.dev
```

These previews build the requested branch but deploy it through fork-owned tooling from `develop`. They reuse the production RDS, Redis, Meilisearch, EFS storage, tenant accounts, and secrets from `openmercato.they.dev`.

Use this only when production-data testing is the point of the check. If migration files changed, the upsert workflow fails unless it is manually rerun with `allow_prod_migrations=true`.

Cleanup workflow:

```text
.github/workflows/cf-preview-destroy.yml
```

Full runbook: `infra/OPEN_MERCATO_AWS_ENVIRONMENTS.md`.

## Stable upstream baseline

The stable comparison environment remains:

```text
https://om.they.dev
```

It should always deploy from:

```text
TH-EY/open-mercato:upstream-baseline
```

Do not use `om.they.dev` as a temporary preview for feature work.

## Legacy shared slots

The following manual shared-slot workflows remain in the repo for older QA flows:

- `.github/workflows/qa-deploy.yml`
- `.github/workflows/qa-stop-on-merge.yml`

These slots are no longer the preferred path for upstream contribution testing.

Use them only if you explicitly need the old slot-based Docker preview image flow.
