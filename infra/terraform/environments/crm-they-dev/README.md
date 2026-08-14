# crm.they.dev Terraform Environment

This is the source of truth for the single-company THEY Open Mercato CRM environment.
It must run in AWS London (`eu-west-2`) and is intentionally sized for one durable
company instance, not previews or multi-tenant capacity.

## Runtime assumptions

- Source branch starts from upstream `develop` and carries THEY-specific runtime/infra changes.
- CSV import from `origin/contrib/sync-excel` must remain present until it is merged upstream.
- EC2 runs the app, worker, local Redis, and local Meilisearch.
- RDS PostgreSQL is managed by AWS with encrypted gp3 storage and 7-day backups.
- Container stdout/stderr, host syslog/auth, SSM command output, and RDS engine
  logs are centralized in AWS with explicit retention.
- Ingress reuses the existing `they-lb` HTTPS listener and wildcard `*.they.dev` certificate.

## Operational logs

CloudWatch Logs groups:

- Containers: `/openmercato/crm/{app,worker,redis,meilisearch,mcp,opencode}`
- Host: `/openmercato/crm/host`, with `{instance_id}/syslog` and
  `{instance_id}/auth` streams
- SSM deploys and diagnostics: `/aws/ssm/openmercato-crm-they-dev/deploy`
- RDS: `/aws/rds/instance/openmercato-crm-they-dev-postgres/{postgresql,upgrade}`

Container, host, and RDS groups retain 30 days by default. SSM output retains
14 days. Terraform precreates the groups and preserves them when resources are
removed from configuration. Docker uses non-blocking delivery with an 8 MiB
per-container buffer, so an extended CloudWatch outage can drop operational
events without blocking the CRM processes.

Every CRM group audits and masks AWS secret keys, email addresses, and common
private-key formats at view time. Masking applies only to events ingested after
the policy is created; source-side log minimization remains required.

The shared `they-lb` access, connection, and health-check logs are intentionally
not enabled here. AWS configures these at load-balancer scope, which would
capture traffic for every service on the shared ALB, not only `crm.they.dev`.

## Commands

```bash
cd infra/terraform/environments/crm-they-dev
tofu init
tofu plan
```

The CRM GitHub Actions infrastructure workflow is intentionally plan-only. The
current environment has unrelated live drift, including an EC2 AMI replacement.
Approved observability changes must use a saved, reviewed targeted plan or an
exact AWS API operation that does not touch EC2, the shared ALB, DNS, database
networking, or unrelated IAM statements.

After Terraform creates the EC2 host and ECR repository, deploy the app image with:

```bash
APP_IMAGE=<account>.dkr.ecr.eu-west-2.amazonaws.com/openmercato-crm-they-dev-app:<tag> \
  bash scripts/crm/deploy-crm-they-dev.sh
```

GitHub Actions wrappers are available:

- `.github/workflows/crm-they-dev-infra.yml`
- `.github/workflows/crm-they-dev-deploy.yml`

## Cost controls

Defaults are intentionally small:

- EC2 `t3a.medium` instead of `t3.small` because `small` has only 2 GB RAM.
- RDS `db.t4g.micro`, Single-AZ, 20 GB gp3.
- Local Redis and Meilisearch instead of ElastiCache or separate managed search.
- Low DB pools and worker concurrency in `docker-compose.crm.yml`.

## Validation and rollback

Before deployment:

```bash
tofu fmt -check -recursive infra/terraform
node --test scripts/__tests__/crm-observability.test.mjs
bash -n scripts/crm/deploy-crm-they-dev.sh scripts/crm/ssm-run-step.sh
docker compose --env-file /dev/null -f docker-compose.crm.yml config --no-interpolate --quiet
```

After deployment, verify log-group retention, recent events for every active
service, CloudWatch Agent association success, RDS export state, container log
drivers, the ALB target health, and an authenticated CRM browser flow.

To roll back container routing, deploy the previous immutable CRM commit/image
and recreate the active services. Keep the CloudWatch groups during rollback so
incident evidence remains available. Revert IAM only after every active
container is back on `json-file` and the CloudWatch Agent is stopped; disabling
RDS exports does not delete already delivered log events.
