# crm.they.dev Terraform Environment

This is the source of truth for the single-company THEY Open Mercato CRM environment.
It must run in AWS London (`eu-west-2`) and is intentionally sized for one durable
company instance, not previews or multi-tenant capacity.

## Runtime assumptions

- Source branch starts from upstream `develop` and carries THEY-specific runtime/infra changes.
- CSV import from `origin/contrib/sync-excel` must remain present until it is merged upstream.
- EC2 runs the app, worker, local Redis, and local Meilisearch.
- RDS PostgreSQL is managed by AWS with encrypted gp3 storage and 7-day backups.
- Ingress reuses the existing `they-lb` HTTPS listener and wildcard `*.they.dev` certificate.

## Commands

```bash
cd infra/terraform/environments/crm-they-dev
tofu init
tofu plan
tofu apply
```

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
