# Open Mercato AWS - Access Details

## Application

| | |
|---|---|
| **URL** | https://openmercato.they.dev |
| **Login page** | https://openmercato.they.dev/login |
| **Admin panel** | https://openmercato.they.dev/backend |
| **ALB (direct)** | http://openmercato-alb-755531696.eu-west-2.elb.amazonaws.com |

## Login Credentials

| Role | Email | Password |
|------|-------|----------|
| Superadmin | `superadmin@acme.com` | `BobryLubiaKobry123!` |
| Admin | `admin@acme.com` | `BobryLubiaKobry123!` |

## AWS Account

| | |
|---|---|
| **Account ID** | `062648047691` |
| **Region** | `eu-west-2` (London) |
| **Stack name** | `openmercato` |
| **IaC** | CloudFormation (`infra/cloudformation/openmercato.yml`) |

## Infrastructure Management

```bash
# Check stack status
aws cloudformation describe-stacks --stack-name openmercato --region eu-west-2 --query 'Stacks[0].{Status:StackStatus,Outputs:Outputs}'

# Update stack after template changes
APP_IMAGE=062648047691.dkr.ecr.eu-west-2.amazonaws.com/openmercato-app:latest \
JWT_SECRET_ARN=arn:aws:secretsmanager:eu-west-2:062648047691:secret:openmercato/prod/jwt-secret-rexWm3 \
ENCRYPTION_KEY_ARN=arn:aws:secretsmanager:eu-west-2:062648047691:secret:openmercato/prod/encryption-key-U7Kf1s \
bash infra/cloudformation/deploy.sh update

# Check recent events
bash infra/cloudformation/deploy.sh events

# Detect drift
aws cloudformation detect-stack-drift --stack-name openmercato --region eu-west-2
```

## Deploy New Version

```bash
# Login to ECR
aws ecr get-login-password --region eu-west-2 | docker login --username AWS --password-stdin 062648047691.dkr.ecr.eu-west-2.amazonaws.com

# Build and push (ARM64)
docker build --platform linux/arm64 -t 062648047691.dkr.ecr.eu-west-2.amazonaws.com/openmercato-app:latest .
docker push 062648047691.dkr.ecr.eu-west-2.amazonaws.com/openmercato-app:latest

# Deploy
aws ecs update-service --cluster openmercato-cluster --service openmercato-web --force-new-deployment --region eu-west-2
aws ecs update-service --cluster openmercato-cluster --service openmercato-worker-worker --force-new-deployment --region eu-west-2
```

## Secrets Manager

| Secret | ARN |
|--------|-----|
| JWT Secret | `arn:aws:secretsmanager:eu-west-2:062648047691:secret:openmercato/prod/jwt-secret-rexWm3` |
| Encryption Key | `arn:aws:secretsmanager:eu-west-2:062648047691:secret:openmercato/prod/encryption-key-U7Kf1s` |
| Database URL | `openmercato/prod/database-url` (composed by Lambda) |
| Redis URL | `openmercato/prod/redis-url` (composed by Lambda) |
| Meilisearch API Key | `openmercato/prod/meilisearch-api-key` (auto-generated) |
| Redis Auth Token | `openmercato/prod/redis-auth-token` (auto-generated) |
| RDS Master Password | Auto-managed by RDS |

## Logs

```bash
aws logs tail /ecs/openmercato/web --follow --region eu-west-2
aws logs tail /ecs/openmercato/worker-worker --follow --region eu-west-2
aws logs tail /ecs/openmercato/meilisearch --follow --region eu-west-2
```

## Change Passwords

```bash
aws ecs run-task --cluster openmercato-cluster \
  --task-definition openmercato-web \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[SUBNET_IDS],securityGroups=[SG_ID],assignPublicIp=ENABLED}" \
  --overrides '{"containerOverrides":[{"name":"app","command":["sh","-c","yarn mercato auth set-password --email <EMAIL> --password <NEW_PASSWORD>"]}]}' \
  --region eu-west-2
```

Password requirements: min 8 chars, one number, one uppercase, one special character.
