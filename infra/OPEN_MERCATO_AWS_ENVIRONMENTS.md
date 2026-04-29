# Open Mercato AWS environments

This file is the operator/developer map for the AWS environments used by this fork. It is intentionally concrete: branch names, hostnames, runtime paths, workflows, and health commands.

## Production fork: `openmercato.they.dev`

| Item | Value |
|------|-------|
| URL | `https://openmercato.they.dev` |
| Source branch | `TH-EY/open-mercato:develop` |
| AWS account | `062648047691` |
| AWS region | `eu-west-2` |
| Runtime | CloudFormation + ECS/Fargate |
| CloudFormation stack | `openmercato` |
| ECS cluster | `openmercato-cluster` |
| Web service | `openmercato-web` |
| Worker service | `openmercato-worker-worker` |
| ECR repo | `062648047691.dkr.ecr.eu-west-2.amazonaws.com/openmercato-app` |
| Deploy workflow | `.github/workflows/deploy-aws.yml` |
| CloudFormation template | `infra/cloudformation/openmercato.yml` |
| Deploy helper | `infra/cloudformation/deploy.sh` |

Production is the fork deployment track. It may contain fork-only CloudFormation/ECS infrastructure and operational workflow code that must not be copied into upstream contribution branches.

### Shared AWS resources

The `openmercato` stack owns or wires the app runtime around these resources:

- RDS PostgreSQL endpoint exposed by the stack output `DatabaseEndpoint`.
- ElastiCache Redis replication group used for Redis, queue, and cache URLs.
- ECS-hosted Meilisearch service discovered as `meilisearch.openmercato.internal:7700`.
- EFS application storage mounted at `/app/apps/mercato/storage`.
- Secrets Manager values for `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `TENANT_DATA_ENCRYPTION_KEY`, and `MEILISEARCH_API_KEY`.
- Shared `they-lb` HTTPS listener and Route53 alias for `openmercato.they.dev`.
- Target group `openmercato-they-tg` for the web service.

Open Mercato does not own the shared ALB itself. The stack owns the host-header listener rule and a Lambda/EventBridge target sync that registers ECS task IPs in the shared target group.

### Deploying production

Normal deploy builds a new ARM64 image, pushes it to ECR, deploys CloudFormation, waits for ECS stability, and runs auth/dashboard smoke:

```bash
gh workflow run deploy-aws.yml \
  --repo TH-EY/open-mercato \
  --ref develop \
  -f environment=production
```

Fast redeploy skips the Docker build and deploys an existing ECR image. Use this for retrying CloudFormation/ECS after a workflow or IAM failure when the image is already in ECR:

```bash
gh workflow run deploy-aws.yml \
  --repo TH-EY/open-mercato \
  --ref develop \
  -f environment=production \
  -f app_image_uri=062648047691.dkr.ecr.eu-west-2.amazonaws.com/openmercato-app:<tag-or-sha>
```

The workflow role is `github-openmercato-deploy`. It needs ECR push/read, CloudFormation change set permissions, ECS describe/wait, Secrets Manager parameter access through the stack, and S3 access to the CloudFormation template artifact prefix.

### Production checks

```bash
aws cloudformation describe-stacks \
  --region eu-west-2 \
  --stack-name openmercato \
  --query 'Stacks[0].{status:StackStatus,updated:LastUpdatedTime}' \
  --output table

aws ecs describe-services \
  --region eu-west-2 \
  --cluster openmercato-cluster \
  --services openmercato-web openmercato-worker-worker \
  --query 'services[].{service:serviceName,desired:desiredCount,running:runningCount,pending:pendingCount,rollout:deployments[0].rolloutState,taskDefinition:deployments[0].taskDefinition}' \
  --output table

aws elbv2 describe-target-health \
  --region eu-west-2 \
  --target-group-arn arn:aws:elasticloadbalancing:eu-west-2:062648047691:targetgroup/openmercato-they-tg/151040b5443efa2c \
  --query 'TargetHealthDescriptions[].{target:Target.Id,port:Target.Port,health:TargetHealth.State,reason:TargetHealth.Reason}' \
  --output table

curl -I https://openmercato.they.dev/
curl -I https://openmercato.they.dev/login
```

## Upstream baseline: `om.they.dev`

| Item | Value |
|------|-------|
| URL | `https://om.they.dev` |
| Source branch | `TH-EY/open-mercato:upstream-baseline` |
| Source mirror | `upstream/develop` -> `origin/upstream-baseline` |
| Runtime | EC2 + Dokploy + Docker Compose |
| EC2 instance | `i-0c6ec8e5a53900297` |
| EC2 name | `openmercato-upstream-baseline-dokploy` |
| App checkout | `/etc/dokploy/compose/baseline-zjkhnl/code` |
| Compose file | `docker-compose.fullapp.yml` |
| App port | `3001` |
| Target group | `openmercato-upstream-baseline-tg` |
| Health path | `/login` |
| Runbook | `infra/aws-upstream-baseline/README.md` |

The baseline is the stable upstream-parity environment. It is not a feature preview and it must not point at `develop` or direct upstream `open-mercato/open-mercato:develop`. It must point at the fork mirror branch because the fork owns the automation around this AWS host.

Required Git source on the EC2 checkout:

```text
remote: https://github.com/TH-EY/open-mercato.git
branch: upstream-baseline
refspec: +refs/heads/*:refs/remotes/origin/*
```

### Syncing the mirror branch

`origin/upstream-baseline` is force-synced from external upstream:

```bash
git fetch origin upstream --prune
git push origin upstream/develop:upstream-baseline --force-with-lease
```

The repository also has `.github/workflows/sync-upstream-baseline.yml` for this mirror operation.

### Baseline deploy/recovery on the EC2 host

Use SSM. Do not SSH manually unless SSM is unavailable.

```bash
aws ssm send-command \
  --region eu-west-2 \
  --instance-ids i-0c6ec8e5a53900297 \
  --document-name AWS-RunShellScript \
  --parameters commands='["cd /etc/dokploy/compose/baseline-zjkhnl/code && git remote set-url origin https://github.com/TH-EY/open-mercato.git && git config --unset-all remote.origin.fetch || true && git config --add remote.origin.fetch +refs/heads/*:refs/remotes/origin/* && git fetch origin --prune && git checkout -B upstream-baseline origin/upstream-baseline && git reset --hard origin/upstream-baseline && docker compose --env-file .env -f docker-compose.fullapp.yml -p baseline-zjkhnl up -d --build --remove-orphans"]'
```

For a shell session already on the instance, the core recovery command is:

```bash
cd /etc/dokploy/compose/baseline-zjkhnl/code
git remote set-url origin https://github.com/TH-EY/open-mercato.git
git config --unset-all remote.origin.fetch || true
git config --add remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
git fetch origin --prune
git checkout -B upstream-baseline origin/upstream-baseline
git reset --hard origin/upstream-baseline
docker compose --env-file .env -f docker-compose.fullapp.yml -p baseline-zjkhnl up -d --build --remove-orphans
```

### Baseline checks

```bash
./infra/aws-upstream-baseline/check-health.sh

aws elbv2 describe-target-health \
  --region eu-west-2 \
  --target-group-arn arn:aws:elasticloadbalancing:eu-west-2:062648047691:targetgroup/openmercato-upstream-baseline-tg/10a6c24bb7e46496 \
  --query 'TargetHealthDescriptions[].{target:Target.Id,port:Target.Port,health:TargetHealth.State,reason:TargetHealth.Reason}' \
  --output table

curl -I https://om.they.dev/
curl -I https://om.they.dev/login
```

Useful remote checks through SSM:

```bash
# app must listen on 3001
ss -ltnp | grep ':3001'

# baseline checkout must be upstream-baseline from TH-EY/open-mercato
git -C /etc/dokploy/compose/baseline-zjkhnl/code remote -v
git -C /etc/dokploy/compose/baseline-zjkhnl/code branch --show-current
git -C /etc/dokploy/compose/baseline-zjkhnl/code rev-parse HEAD

# baseline compose state
cd /etc/dokploy/compose/baseline-zjkhnl/code
docker compose --env-file .env -f docker-compose.fullapp.yml -p baseline-zjkhnl ps
```

## Existing feature previews: `preview-<slug>.om.they.dev`

| Item | Value |
|------|-------|
| Supported branches | `contrib/*` only |
| URL pattern | `https://preview-<slug>.om.they.dev` |
| Runtime | Isolated Docker Compose stack on `i-0c6ec8e5a53900297` |
| Remote root | `/opt/openmercato-previews` |
| Workdir | `/opt/openmercato-previews/<slug>` |
| Compose project | `preview-<slug>` |
| Repo | `https://github.com/TH-EY/open-mercato.git` |
| App ports | deterministic free port in `4100-4899` |
| Target group name | `om-prv-<10-char-sha1>` |
| Upsert workflow | `.github/workflows/contrib-preview-upsert.yml` |
| Destroy workflow | `.github/workflows/contrib-preview-destroy.yml` |

These previews are for upstream-candidate work. They intentionally run outside CloudFormation/ECS to stay close to upstream Docker Compose runtime while still being reachable through the shared AWS ingress.

### Slug, hostname, port, and target group

`infra/aws-upstream-baseline/preview-common.sh` derives all identifiers from the branch name:

- Strip `refs/heads/` if present.
- Strip the leading `contrib/` for the readable part.
- Lowercase and replace non-alphanumeric characters with `-`.
- Append a 6-character SHA1 suffix of the full branch name.
- Hostname: `preview-<slug>.om.they.dev`.
- Target group: `om-prv-<first-10-sha1-of-slug>`.
- Port: reuse existing target group port or choose a deterministic free port in `4100-4899`.

Example:

```text
branch: contrib/sync-excel
host:   preview-sync-excel-<hash>.om.they.dev
stack:  Docker Compose project preview-sync-excel-<hash>
```

### Upserting a preview

`.github/workflows/contrib-preview-upsert.yml` has a `push` trigger for `contrib/**` and can also be triggered manually. In practice, `contrib/*` branches cut from `upstream-baseline` may not contain fork-only workflow files, so the reliable operator path is manual dispatch from `develop`:

```bash
gh workflow run contrib-preview-upsert.yml \
  --repo TH-EY/open-mercato \
  --ref develop \
  -f branch=contrib/my-feature
```

The workflow:

1. Resolves and validates the branch name; only `contrib/*` is accepted.
2. Assumes the `github-openmercato-deploy` AWS role.
3. Runs `infra/aws-upstream-baseline/preview-upsert.sh <branch>`.
4. Runs `infra/aws-upstream-baseline/smoke.sh` against the preview URL.
5. Comments the preview URL on same-repo open PRs for that branch.

`preview-upsert.sh` sends an SSM command to the baseline EC2 host. On the host it:

1. Clones or hard-resets `/opt/openmercato-previews/<slug>` to the requested branch.
2. Copies the baseline `.env` from `/etc/dokploy/compose/baseline-zjkhnl/code/.env`.
3. Rewrites preview-specific values: `APP_NAME`, `DEPLOY_ENV`, `APP_PORT`, `APP_URL`, Postgres password, JWT/auth/encryption secrets, and Meilisearch key.
4. Starts an isolated Compose stack with `docker compose --project-name preview-<slug> --env-file .env -f docker-compose.fullapp.yml up -d --build`.
5. Reconciles the smoke admin if `SMOKE_TEST_EMAIL`, `SMOKE_TEST_PASSWORD`, and `SMOKE_TEST_TENANT_ID` are available.
6. Creates or updates the preview ALB target group and host-header listener rule.
7. Waits for target health and `/login` readiness.

Each preview has its own Postgres, Redis, Meilisearch, app containers, Docker volumes, and generated secrets. It does not share baseline data.

### Ingress setup for previews

`infra/aws-upstream-baseline/enable-preview-hostnames.sh` prepares the shared AWS ingress for all `*.om.they.dev` previews:

- allows `they-lb` security group ingress to EC2 ports `4100-4899`;
- requests or reuses ACM cert `*.om.they.dev` with SAN `om.they.dev`;
- attaches that cert to the shared HTTPS listener;
- creates wildcard Route53 alias `*.om.they.dev` -> `they-lb`.

Per preview, `preview-upsert.sh` then creates or updates:

- one ALB target group, target type `instance`;
- one registered target: `i-0c6ec8e5a53900297:<preview_port>`;
- one HTTPS listener rule for host header `preview-<slug>.om.they.dev`;
- health check `GET /login` with `200-399` matcher.

### Destroying previews

Automatic cleanup runs on branch delete for `contrib/*`. Manual cleanup:

```bash
gh workflow run contrib-preview-destroy.yml \
  --repo TH-EY/open-mercato \
  --ref develop \
  -f branch=contrib/my-feature
```

The destroy script:

1. Runs `docker compose down --volumes --remove-orphans` in `/opt/openmercato-previews/<slug>`.
2. Deletes the remote workdir.
3. Deletes the matching ALB listener rule.
4. Deregisters the EC2 target and deletes the preview target group.

## Branch rules

| Work type | Branch source | Branch name | Deploy target |
|-----------|---------------|-------------|---------------|
| Fork production deploy | `origin/develop` | `develop`, `fork/*`, `sync/*` | `openmercato.they.dev` |
| Upstream mirror | `upstream/develop` | `upstream-baseline` | `om.they.dev` |
| Upstream candidate | `origin/upstream-baseline` | `contrib/*` | `preview-<slug>.om.they.dev` |

Rules that matter operationally:

- Never start upstream-candidate work from `develop`.
- Never merge `develop` into `contrib/*`.
- Never point `om.they.dev` at `develop` or direct upstream.
- Never put fork-only CloudFormation/ECS paths into `contrib/*`.
- If a change must land on `openmercato.they.dev` before upstream accepts it, cherry-pick it into a separate `sync/<topic>-to-develop` branch.

## Troubleshooting map

### GitHub Actions deploy failed before stack update

Check the failing step first:

```bash
gh run view <run-id> --repo TH-EY/open-mercato --json status,conclusion,url,jobs
gh run view <run-id> --repo TH-EY/open-mercato --job <job-id> --log
```

Common causes:

- Docker build failure: fix code/build, push `develop`, rerun normal deploy.
- Missing CloudFormation permission: stack remains unchanged; fix `github-openmercato-deploy` IAM and rerun.
- Image already pushed but deploy failed: rerun `.github/workflows/deploy-aws.yml` with `app_image_uri`.

### `openmercato.they.dev` returns 502

Check in this order:

```bash
aws cloudformation describe-stacks --region eu-west-2 --stack-name openmercato --query 'Stacks[0].StackStatus' --output text
aws ecs describe-services --region eu-west-2 --cluster openmercato-cluster --services openmercato-web openmercato-worker-worker --output table
aws elbv2 describe-target-health --region eu-west-2 --target-group-arn arn:aws:elasticloadbalancing:eu-west-2:062648047691:targetgroup/openmercato-they-tg/151040b5443efa2c --output table
```

If ECS has healthy running tasks but the target group has stale unhealthy IPs, deregister only stale targets that no longer match running ECS task ENI IPs.

### `om.they.dev` returns 502

Most likely causes:

- app container is missing or not listening on port `3001`;
- checkout is on `develop` or direct upstream instead of `upstream-baseline`;
- checkout refspec only fetches `develop`, so `origin/upstream-baseline` is unavailable;
- target group health check `/login` fails.

Remote checks:

```bash
ss -ltnp | grep ':3001' || true
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' | grep upstream-baseline || true
git -C /etc/dokploy/compose/baseline-zjkhnl/code remote -v
git -C /etc/dokploy/compose/baseline-zjkhnl/code branch --show-current
```

### `preview-<slug>.om.they.dev` fails

Check:

```bash
BRANCH=contrib/my-feature
./infra/aws-upstream-baseline/preview-upsert.sh "$BRANCH"
./infra/aws-upstream-baseline/smoke.sh
```

On AWS:

```bash
aws elbv2 describe-target-groups --region eu-west-2 --query 'TargetGroups[?starts_with(TargetGroupName, `om-prv-`)].{name:TargetGroupName,port:Port,arn:TargetGroupArn}' --output table
aws elbv2 describe-rules --region eu-west-2 --listener-arn arn:aws:elasticloadbalancing:eu-west-2:062648047691:listener/app/they-lb/fe10e6ccedf3d536/15478d3e1d97aedc --output table
```

On the EC2 host, check the generated workdir and project:

```bash
ls -la /opt/openmercato-previews
cd /opt/openmercato-previews/<slug>
docker compose --project-name preview-<slug> --env-file .env -f docker-compose.fullapp.yml ps
```

## Planned CloudFormation/ECS previews: `preview-<slug>.openmercato.they.dev`

This is not implemented yet.

Planned model:

- supported source: trusted branches/PRs, initially `contrib/*` plus manual dispatch;
- URL pattern: `https://preview-<slug>.openmercato.they.dev`;
- runtime: separate CloudFormation/ECS preview service per branch;
- data model: live writable production RDS, Redis, Meilisearch, EFS, tenant accounts, and secrets;
- no scheduler service in preview;
- migration policy: manual gate before allowing a preview branch to run DB migrations on production data;
- active preview limit: 8.

Warning: this planned model can mutate production tenant data and trigger shared side effects. Use it only for trusted branches/operators and for tests where production data mutation is acceptable.
