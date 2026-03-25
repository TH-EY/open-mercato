# Open Mercato AWS Deployment - Changelog

## Session: 2026-03-24 / 2026-03-25

### What was done

Deployed Open Mercato on AWS from scratch, iterated through cost optimizations, and migrated from Terraform to CloudFormation.

### Reconciliation update (2026-03-25)

- Migrated production ingress from the dedicated `openmercato-alb` to the shared
  `they-lb`
- Reconciled the `openmercato` CloudFormation stack so it no longer tries to
  recreate the dedicated ALB
- Documented that `they-lb`, its HTTPS listener/certificate, the shared target
  group, and cross-VPC networking are external shared dependencies rather than
  stack-owned resources
- Verified post-update stack drift status is `IN_SYNC`

### Commits

| Commit | Description |
|--------|-------------|
| `4a02a38d` | Initial AWS ECS Terraform module (18 files) + CI/CD workflows |
| `29beae6b` | AWS deployment integration guide |
| `776b1dc5` | Custom domain (openmercato.they.dev) + cost optimization ($235 -> $104) |
| `9519442b` | ARM64 Graviton + RDS recreated at 20 GB ($104 -> $91) |
| `cff07251` | Migrated from Terraform to CloudFormation (single template) |

### Infrastructure Evolution

| Stage | IaC | Monthly Cost | Key Changes |
|-------|-----|-------------|-------------|
| Initial deploy | Terraform (18 .tf files) | ~$235 | RDS db.t4g.medium 50 GB, x86 Fargate, NAT Gateway |
| Cost optimization | Terraform | ~$104 | Downsized RDS/Fargate, removed NAT Gateway, public subnets |
| ARM64 + RDS resize | Terraform | ~$91 | Graviton ARM64, RDS recreated at 20 GB gp3 |
| CloudFormation migration | CloudFormation (1 template) | ~$91 | Replaced Terraform with native AWS CloudFormation |

### Current State

| Component | Details | Cost |
|-----------|---------|------|
| ECS Web (ARM64 Graviton) | 0.5 vCPU / 2 GB | $19.57 |
| ECS Worker (ARM64 Graviton) | 0.25 vCPU / 0.5 GB | $8.29 |
| ECS Meilisearch (ARM64 Graviton) | 0.25 vCPU / 0.5 GB | $8.29 |
| RDS PostgreSQL 18.3 + pgvector | db.t4g.micro, 20 GB gp3 | $15.50 |
| ElastiCache Redis 7.1 | cache.t4g.micro, TLS + auth | $13.14 |
| Shared they-lb ingress | External shared dependency, not stack-owned | Included outside this stack |
| Other (EFS, ECR, Logs, Secrets, DNS) | | $8.07 |
| **Total** | | **~$91/mo** |

### Access

| | |
|---|---|
| **URL** | https://openmercato.they.dev |
| **Login** | `superadmin@acme.com` / `BobryLubiaKobry123!` |
| **AWS Region** | eu-west-2 (London) |
| **Stack** | `openmercato` (CloudFormation) |
| **ECR** | `062648047691.dkr.ecr.eu-west-2.amazonaws.com/openmercato-app` |

### Key Decisions & Learnings

| Decision | Rationale |
|----------|-----------|
| Public subnets for ECS (no NAT) | Saves $36/mo; security groups still restrict inbound |
| ARM64 Graviton | ~20% cheaper Fargate; node:24-alpine + meilisearch both support arm64 |
| RDS 20 GB gp3 (not 50 GB) | gp3 minimum is 20 GB; RDS storage can't shrink so required recreation |
| CloudFormation over Terraform | Native AWS, no external state/tooling; single YAML template |
| Lambda custom resource for DB URL | CloudFormation can't read RDS managed password at deploy time; app requires full DATABASE_URL |
| `DB_SSL=true` + `DB_SSL_REJECT_UNAUTHORIZED=false` | RDS SSL with pg driver v8+; sslmode in URL causes verify-full behavior |
| No container health check for web | Alpine image has no curl/wget; ALB health check is sufficient |
| split_workers mode | Web + worker as separate ECS services; worker handles 12+ queue types |

### Files

| File | Purpose |
|------|---------|
| `infra/cloudformation/openmercato.yml` | CloudFormation template (all resources) |
| `infra/cloudformation/deploy.sh` | Helper script (create/update/destroy/status) |
| `.github/workflows/deploy-aws.yml` | CI/CD: build ARM64 image, push ECR, deploy ECS |
| `infra/AWS_ACCESS.md` | Access details, credentials, commands |
| `infra/AWS_DEPLOYMENT.md` | Full integration guide |
| `infra/AWS_CHANGELOG.md` | This file |
