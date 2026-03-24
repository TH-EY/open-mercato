# Open Mercato AWS - Access Details

## Application

| | |
|---|---|
| **URL** | https://openmercato.they.dev |
| **Login page** | https://openmercato.they.dev/login |
| **Admin panel** | https://openmercato.they.dev/backend |
| **ALB (direct)** | http://openmercato-alb-1364343514.eu-west-2.elb.amazonaws.com |

## Login Credentials

| Role | Email | Password |
|------|-------|----------|
| Superadmin | `superadmin@acme.com` | `BobryLubiaKobry123!` |
| Admin | `admin@acme.com` | `BobryLubiaKobry123!` |

To change passwords:
```bash
# Via one-off ECS task:
aws ecs run-task --cluster openmercato-cluster \
  --task-definition openmercato-web \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[PRIVATE_SUBNET_IDS],securityGroups=[APP_SG_ID],assignPublicIp=DISABLED}" \
  --overrides '{"containerOverrides":[{"name":"app","command":["sh","-c","yarn mercato auth set-password --email <EMAIL> --password <NEW_PASSWORD>"]}]}' \
  --region eu-west-2
```

Password requirements: minimum 8 characters, one number, one uppercase letter, one special character.

## AWS Account

| | |
|---|---|
| **Account ID** | `062648047691` |
| **Region** | `eu-west-2` (London) |
| **IAM User** | `patryk-madaj` |

## Secrets Manager (eu-west-2)

| Secret | ARN |
|--------|-----|
| JWT Secret | `arn:aws:secretsmanager:eu-west-2:062648047691:secret:openmercato/jwt-secret-1dR5AI` |
| Encryption Key | `arn:aws:secretsmanager:eu-west-2:062648047691:secret:openmercato/encryption-key-oTanjm` |
| Database URL | `arn:aws:secretsmanager:eu-west-2:062648047691:secret:openmercato/database-url-UmuOVC` |
| Redis URL | `arn:aws:secretsmanager:eu-west-2:062648047691:secret:openmercato/redis-url-ndWHZ4` |
| Meilisearch API Key | `arn:aws:secretsmanager:eu-west-2:062648047691:secret:openmercato/meilisearch-api-key-lcVlsA` |
| RDS Master Password | Auto-managed by RDS |

Retrieve any secret:
```bash
aws secretsmanager get-secret-value --secret-id openmercato/<name> --region eu-west-2 --query SecretString --output text
```

## Infrastructure Endpoints

| Service | Endpoint | Access |
|---------|----------|--------|
| **ALB** | `openmercato-alb-1364343514.eu-west-2.elb.amazonaws.com` | Public (HTTP :80) |
| **RDS PostgreSQL 18.3** | `openmercato-postgres.c5lnjmd9ukid.eu-west-2.rds.amazonaws.com:5432` | Private only (VPC) |
| **ElastiCache Redis 7.1** | `master.openmercato-redis.bnyj2w.euw2.cache.amazonaws.com:6379` | Private only (VPC, TLS + auth) |
| **Meilisearch** | `meilisearch.openmercato.internal:7700` | Private only (Cloud Map) |
| **ECR** | `062648047691.dkr.ecr.eu-west-2.amazonaws.com/openmercato-app` | AWS auth |

## ECS Services

| Service | Task Definition | CPU/Memory | Count |
|---------|----------------|------------|-------|
| `openmercato-web` | `openmercato-web:8` | 1024 / 4096 MB | 1 |
| `openmercato-worker-worker` | `openmercato-worker-worker:5` | 512 / 1024 MB | 1 |
| `openmercato-meilisearch` | `openmercato-meilisearch:1` | 512 / 1024 MB | 1 |

## Networking

| Resource | Value |
|----------|-------|
| VPC | `vpc-04c60f4d0fb58a256` (`10.1.0.0/16`) |
| Public subnets | `10.1.1.0/24` (2a), `10.1.2.0/24` (2b) |
| Private subnets | `10.1.10.0/24` (2a), `10.1.11.0/24` (2b) |

## Logs

```bash
# Tail web logs
aws logs tail /ecs/openmercato/web --follow --region eu-west-2

# Tail worker logs
aws logs tail /ecs/openmercato/worker-worker --follow --region eu-west-2

# Tail meilisearch logs
aws logs tail /ecs/openmercato/meilisearch --follow --region eu-west-2
```

## Terraform

```bash
cd infra/terraform/environments/production
tofu init        # first time
tofu plan        # preview
tofu apply       # apply
```

State: `s3://openmercato-terraform-state-062648047691-eu-west-2/production/terraform.tfstate`

## Deploy New Version

```bash
# Login to ECR
aws ecr get-login-password --region eu-west-2 | docker login --username AWS --password-stdin 062648047691.dkr.ecr.eu-west-2.amazonaws.com

# Build and push
docker build --platform linux/amd64 -t 062648047691.dkr.ecr.eu-west-2.amazonaws.com/openmercato-app:latest .
docker push 062648047691.dkr.ecr.eu-west-2.amazonaws.com/openmercato-app:latest

# Deploy
aws ecs update-service --cluster openmercato-cluster --service openmercato-web --force-new-deployment --region eu-west-2
aws ecs update-service --cluster openmercato-cluster --service openmercato-worker-worker --force-new-deployment --region eu-west-2
```
