# QA Deployment Guide

This guide explains the current QA and preview options for this fork.

## Overview

There are now two different deployment paths:

1. Per-branch contrib previews on `preview-<slug>.om.they.dev`
2. Legacy shared QA slots (`qa1` / `qa2`)

Use per-branch previews for upstream-candidate work. Use shared slots only for older fork workflows that still depend on the preview Docker image flow.

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
- restores the seeded `om.they.dev` baseline database into that branch-local Postgres before app startup
- reuses the baseline tenant encryption secrets required to read the seeded data
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

## Stable upstream baseline

The stable seeded QA environment remains:

```text
https://om.they.dev
```

It should always deploy from:

```text
TH-EY/open-mercato:upstream-baseline
```

Do not use `om.they.dev` as a temporary preview for feature work.
Use `/infra/aws-upstream-baseline/restore-baseline-from-cloudformation.sh` when you need to refresh the seeded QA dataset from the old CloudFormation stack.

## Legacy shared slots

The following manual shared-slot workflows remain in the repo for older QA flows:

- `.github/workflows/qa-deploy.yml`
- `.github/workflows/qa-stop-on-merge.yml`

These slots are no longer the preferred path for upstream contribution testing.

Use them only if you explicitly need the old slot-based Docker preview image flow.
