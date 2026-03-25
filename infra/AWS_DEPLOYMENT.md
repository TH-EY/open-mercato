# Open Mercato - AWS Deployment Integration Guide

## Application URL

**Live URL:** https://openmercato.they.dev

| Page | URL |
|------|-----|
| Homepage | https://openmercato.they.dev/ |
| Login | https://openmercato.they.dev/login |
| Backend (admin) | https://openmercato.they.dev/backend |

## Default Login Credentials

The init process creates these default users:

| Role | Email | Password |
|------|-------|----------|
| Superadmin | `superadmin@acme.com` | `password` |
| Admin | `admin@acme.com` | `password` |

**Important:** Change these passwords immediately in a production environment.

Self-service onboarding is enabled - new organizations can be created from the login page.

---

## AWS Account Details

| Setting | Value |
|---------|-------|
| AWS Account ID | `062648047691` |
| Region | `eu-west-2` (London) |
| IAM User | `patryk-madaj` |

---

## Infrastructure Components

### ECS Cluster

| Component | Name | Status |
|-----------|------|--------|
| Cluster | `openmercato-cluster` | Active |
| Web Service | `openmercato-web` | 1/1 running |
| Worker Service | `openmercato-worker-worker` | 1/1 running |
| Meilisearch Service | `openmercato-meilisearch` | 1/1 running |

**Web service:** 1024 CPU / 4096 MB memory, split_workers mode (no auto-spawned workers)
**Worker service:** 512 CPU / 1024 MB memory, runs `yarn mercato queue worker --all`
**Meilisearch:** 512 CPU / 1024 MB memory, image `getmeili/meilisearch:v1.11`

### Shared Ingress Load Balancer

| Setting | Value |
|---------|-------|
| Public DNS | `they-lb-1760303051.eu-west-2.elb.amazonaws.com` |
| Public hostname | `openmercato.they.dev` |
| Listener | Shared HTTPS listener on `they-lb` |
| Listener rule | Host header `openmercato.they.dev` → `openmercato-they-tg` |
| Health check | `GET /` on port 3000 |
| Target group | `openmercato-they-tg` |

### Shared Ingress Ownership

Open Mercato no longer has a dedicated ALB. The application stack integrates with
the shared `they-lb` ingress instead.

**Managed by the `openmercato` CloudFormation stack:**

- Route53 alias for `openmercato.they.dev`
- ECS web service attachment to `openmercato-they-tg`
- Host-header listener rule on the shared HTTPS listener
- Lambda/EventBridge sync that re-registers ECS task IPs with `AvailabilityZone=all`
  for cross-VPC health checks

**Managed outside the `openmercato` stack (shared infrastructure):**

- `they-lb`
- the shared HTTPS listener and ACM certificate
- the shared target group `openmercato-they-tg`
- VPC peering and route-table entries between the `they-lb` VPC and the
  Open Mercato VPC

If any of those shared resources change, update the CloudFormation parameters in
`infra/cloudformation/openmercato.yml` before the next stack update:

- `ExistingLoadBalancerDnsName`
- `ExistingLoadBalancerCanonicalHostedZoneId`
- `ExistingLoadBalancerVpcCidr`
- `ExistingLoadBalancerHttpsListenerArn`
- `ExistingLoadBalancerRulePriority`
- `ExistingWebTargetGroupArn`

### Database - RDS PostgreSQL

| Setting | Value |
|---------|-------|
| Endpoint | `openmercato-postgres.c5lnjmd9ukid.eu-west-2.rds.amazonaws.com:5432` |
| Engine | PostgreSQL 18.3 with pgvector |
| Instance class | `db.t4g.medium` |
| Storage | 50 GB gp3, encrypted |
| Database name | `openmercato` |
| Master username | `openmercato` |
| Master password | Managed by AWS Secrets Manager (see below) |
| Publicly accessible | No (private subnets only) |
| Deletion protection | Enabled |
| Backup retention | 7 days |

### Cache - ElastiCache Redis

| Setting | Value |
|---------|-------|
| Endpoint | `master.openmercato-redis.bnyj2w.euw2.cache.amazonaws.com:6379` |
| Engine | Redis 7.1 |
| Node type | `cache.t4g.micro` |
| Encryption | TLS in-transit + at-rest |
| Auth token | Stored in Secrets Manager |

### Search - Meilisearch (ECS)

| Setting | Value |
|---------|-------|
| Internal hostname | `meilisearch.openmercato.internal:7700` |
| Image | `getmeili/meilisearch:v1.11` |
| Storage | EFS (persistent, encrypted) |
| Master key | Stored in Secrets Manager |
| Discovery | AWS Cloud Map (`openmercato.internal` namespace) |

### Container Registry - ECR

| Setting | Value |
|---------|-------|
| Repository URI | `062648047691.dkr.ecr.eu-west-2.amazonaws.com/openmercato-app` |
| Current tags | `latest`, `402f4283` |
| Scan on push | Enabled |
| Encryption | KMS |

### Storage - EFS

| File system | Purpose | Mount path |
|-------------|---------|------------|
| Meilisearch data | Search index persistence | `/meili_data` (UID 1000) |
| App storage | File attachments + init marker | `/app/apps/mercato/storage` (UID 1001) |

### Networking

| Resource | Value |
|----------|-------|
| VPC ID | `vpc-03f86d6288567d640` |
| VPC CIDR | `10.1.0.0/16` |
| Public subnets | `10.1.1.0/24` (eu-west-2a), `10.1.2.0/24` (eu-west-2b) |
| Private subnets | `10.1.10.0/24` (eu-west-2a), `10.1.11.0/24` (eu-west-2b) |
| Shared ingress VPC CIDR | `172.31.0.0/16` |
| VPC peering required | Yes - shared `they-lb` VPC ↔ Open Mercato VPC |
| NAT Gateway | None |

---

## Secrets Manager

All secrets are in AWS Secrets Manager (`eu-west-2`):

| Secret | ARN | Purpose |
|--------|-----|---------|
| JWT Secret | `arn:aws:secretsmanager:eu-west-2:062648047691:secret:openmercato/jwt-secret-1dR5AI` | JWT token signing |
| Encryption Key | `arn:aws:secretsmanager:eu-west-2:062648047691:secret:openmercato/encryption-key-oTanjm` | Tenant data encryption |
| Database URL | `arn:aws:secretsmanager:eu-west-2:062648047691:secret:openmercato/database-url-UmuOVC` | Composed PostgreSQL connection string |
| Redis URL | `arn:aws:secretsmanager:eu-west-2:062648047691:secret:openmercato/redis-url-ndWHZ4` | Redis connection with auth token |
| Meilisearch API Key | `arn:aws:secretsmanager:eu-west-2:062648047691:secret:openmercato/meilisearch-api-key-lcVlsA` | Meilisearch master key |
| RDS Master Password | Auto-managed by RDS (`manage_master_user_password = true`) | PostgreSQL master password |

To retrieve a secret value:
```bash
aws secretsmanager get-secret-value --secret-id openmercato/jwt-secret --region eu-west-2 --query SecretString --output text
```

---

## CloudWatch Logs

| Log group | Service |
|-----------|---------|
| `/ecs/openmercato/web` | Web application |
| `/ecs/openmercato/worker-worker` | Background worker |
| `/ecs/openmercato/meilisearch` | Meilisearch search engine |
| `/ecs/openmercato/scheduler-sync` | Scheduler sync task |

Retention: 30 days.

To tail logs:
```bash
aws logs tail /ecs/openmercato/web --follow --region eu-west-2
```

---

## Autoscaling

| Service | Min | Max | CPU target | Memory target |
|---------|-----|-----|-----------|---------------|
| Web | 1 | 6 | 70% | 80% |
| Worker | 1 | 4 | 70% | 80% |

---

## Historical Terraform Management (deprecated)

The production stack is now managed by CloudFormation via
`infra/cloudformation/openmercato.yml`. The Terraform details below are retained
only as migration history/reference and should not be treated as the source of
truth for current production changes.

### State

| Setting | Value |
|---------|-------|
| S3 bucket | `openmercato-terraform-state-062648047691-eu-west-2` |
| State key | `production/terraform.tfstate` |
| Lock table | `openmercato-terraform-locks` (DynamoDB) |

### Commands

```bash
cd infra/terraform/environments/production

# Initialize (first time or after backend changes)
tofu init

# Preview changes
tofu plan

# Apply changes
tofu apply

# View current outputs
tofu output
```

### Configuration

Production config: `infra/terraform/environments/production/terraform.tfvars` (gitignored - contains secret ARNs).
Example: `infra/terraform/environments/production/terraform.tfvars.example`.

---

## Deployment (CI/CD)

### Manual deployment via CLI

```bash
# 1. Login to ECR
aws ecr get-login-password --region eu-west-2 | docker login --username AWS --password-stdin 062648047691.dkr.ecr.eu-west-2.amazonaws.com

# 2. Build image
docker build --platform linux/amd64 -t 062648047691.dkr.ecr.eu-west-2.amazonaws.com/openmercato-app:latest .

# 3. Push to ECR
docker push 062648047691.dkr.ecr.eu-west-2.amazonaws.com/openmercato-app:latest

# 4. Force new deployment
aws ecs update-service --cluster openmercato-cluster --service openmercato-web --force-new-deployment --region eu-west-2
aws ecs update-service --cluster openmercato-cluster --service openmercato-worker-worker --force-new-deployment --region eu-west-2
```

### Automated deployment via GitHub Actions

Trigger: manual `workflow_dispatch` on `.github/workflows/deploy-aws.yml`.

Required GitHub secrets/variables:
- `AWS_DEPLOY_ROLE_ARN` - IAM role ARN for OIDC-based auth
- `ECR_REPOSITORY_NAME` = `openmercato-app`
- `ECS_CLUSTER_NAME` = `openmercato-cluster`
- `ECS_WEB_SERVICE_NAME` = `openmercato-web`
- `ECS_WEB_TASK_FAMILY` = `openmercato-web`
- `ECS_WORKER_TASK_FAMILY` = `openmercato-worker-worker`
- `ECS_WORKER_SERVICE_NAME` = `openmercato-worker-worker`

---

## Key Environment Variables

These values are currently delivered by the CloudFormation-managed ECS task
definitions. The Terraform notes below are historical.

| Variable | Value | Source |
|----------|-------|--------|
| `NODE_ENV` | `production` | Module default |
| `PORT` | `3000` | Module default |
| `NODE_OPTIONS` | `--max-old-space-size=4096` | Module default |
| `CACHE_STRATEGY` | `redis` | Module default |
| `DB_SSL` | `true` | Module default |
| `DB_SSL_REJECT_UNAUTHORIZED` | `false` | Module default (RDS uses Amazon CA) |
| `AUTO_SPAWN_WORKERS` | `false` | Forced by split_workers mode |
| `AUTO_SPAWN_SCHEDULER` | `false` | Forced by split_workers mode |
| `QUEUE_STRATEGY` | `async` | Forced on worker tasks |
| `MEILISEARCH_HOST` | `http://meilisearch.openmercato.internal:7700` | Cloud Map discovery |
| `SELF_SERVICE_ONBOARDING_ENABLED` | `true` | Production tfvars |
| `APP_URL` | `https://openmercato.they.dev` | Production stack parameter |
| `DATABASE_URL` | (from Secrets Manager) | Injected as ECS secret |
| `CACHE_REDIS_URL` | (from Secrets Manager) | Injected as ECS secret |
| `JWT_SECRET` | (from Secrets Manager) | Injected as ECS secret |
| `TENANT_DATA_ENCRYPTION_KEY` | (from Secrets Manager) | Injected as ECS secret |
| `MEILISEARCH_API_KEY` | (from Secrets Manager) | Injected as ECS secret |

---

## Next Steps

- [ ] Add a custom domain with Route53 + ACM (`dns_mode = "route53"`) for HTTPS
- [ ] Change default admin passwords
- [ ] Configure email sending (set `RESEND_API_KEY` and `EMAIL_FROM`)
- [ ] Set up New Relic monitoring (set `NEW_RELIC_APP_NAME` and `NEW_RELIC_LICENSE_KEY`)
- [ ] Configure GitHub Actions secrets for automated deployments
- [ ] Scale `web_desired_count` to 2+ for high availability
- [ ] Enable `db_multi_az = true` for RDS failover
- [ ] Consider adding WAF (`waf_mode = "existing"`) for additional security
