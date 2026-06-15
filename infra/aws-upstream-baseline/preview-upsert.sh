#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./preview-common.sh
source "${SCRIPT_DIR}/preview-common.sh"

BRANCH="${1:-${BRANCH:-${GITHUB_REF_NAME:-}}}"
if [[ -z "${BRANCH}" ]]; then
  echo "Usage: $0 <contrib/branch-name>" >&2
  exit 1
fi
if [[ "${BRANCH}" != contrib/* ]]; then
  echo "Preview deployments are only supported for contrib/* branches" >&2
  exit 1
fi
DEPLOY_MODE="${DEPLOY_MODE:-full}"
if [[ "${DEPLOY_MODE}" != "full" && "${DEPLOY_MODE}" != "config-restart" ]]; then
  echo "DEPLOY_MODE must be either 'full' or 'config-restart'" >&2
  exit 1
fi

PREVIEW_SLUG="$(branch_to_preview_slug "${BRANCH}")"
PREVIEW_HOSTNAME="$(preview_hostname_for_slug "${PREVIEW_SLUG}")"
TARGET_GROUP_NAME="$(target_group_name_for_slug "${PREVIEW_SLUG}")"
PREVIEW_PORT="$(choose_preview_port "${PREVIEW_SLUG}" "${TARGET_GROUP_NAME}")"
PREVIEW_ENV="preview-${PREVIEW_SLUG}"
PREVIEW_PROJECT="preview-${PREVIEW_SLUG}"
PREVIEW_URL="https://${PREVIEW_HOSTNAME}"
REMOTE_WORKDIR="${PREVIEW_REMOTE_ROOT}/${PREVIEW_SLUG}"

REMOTE_SCRIPT="$(mktemp)"
{
  echo '#!/usr/bin/env bash'
  echo 'set -euo pipefail'
  printf 'branch=%q\n' "${BRANCH}"
  printf 'repo_url=%q\n' "${PREVIEW_REPO_URL}"
  printf 'preview_env=%q\n' "${PREVIEW_ENV}"
  printf 'preview_project=%q\n' "${PREVIEW_PROJECT}"
  printf 'preview_hostname=%q\n' "${PREVIEW_HOSTNAME}"
  printf 'preview_port=%q\n' "${PREVIEW_PORT}"
  printf 'deploy_mode=%q\n' "${DEPLOY_MODE}"
  printf 'workdir=%q\n' "${REMOTE_WORKDIR}"
  printf 'remote_root=%q\n' "${PREVIEW_REMOTE_ROOT}"
  printf 'baseline_env_file=%q\n' "${BASELINE_ENV_FILE_REMOTE}"
  printf 'preview_admin_email=%q\n' "${PREVIEW_ADMIN_EMAIL:-${SMOKE_TEST_EMAIL:-}}"
  printf 'preview_admin_password=%q\n' "${PREVIEW_ADMIN_PASSWORD:-${SMOKE_TEST_PASSWORD:-}}"
  printf 'preview_admin_tenant_id=%q\n' "${PREVIEW_ADMIN_TENANT_ID:-${SMOKE_TEST_TENANT_ID:-}}"
  cat <<'EOF'
command -v git >/dev/null 2>&1 || { echo "Missing git on preview host" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "Missing docker on preview host" >&2; exit 1; }

mkdir -p "$remote_root"
if [[ ! -d "$workdir/.git" ]]; then
  if [[ "$deploy_mode" == "config-restart" ]]; then
    echo "Config-only deploy requires an existing preview checkout at ${workdir}" >&2
    exit 1
  fi
  git clone --branch "$branch" --single-branch "$repo_url" "$workdir"
else
  if [[ "$deploy_mode" == "full" ]]; then
    git -C "$workdir" remote set-url origin "$repo_url"
    git -C "$workdir" fetch origin "$branch" --prune
    git -C "$workdir" checkout -B "$branch" "origin/$branch"
    git -C "$workdir" reset --hard "origin/$branch"
    git -C "$workdir" clean -fdx
  fi
fi

python3 - <<'PY' "$baseline_env_file" "$workdir/.env" "$preview_env" "$preview_port" "$preview_hostname" "$preview_admin_email" "$preview_admin_password" "$deploy_mode"
import secrets, sys
from pathlib import Path
baseline, target, preview_env, preview_port, preview_host, preview_admin_email, preview_admin_password, deploy_mode = sys.argv[1:9]
values = {}
existing = {}
for line in Path(baseline).read_text().splitlines():
    if not line or line.startswith('#') or '=' not in line:
        continue
    key, value = line.split('=', 1)
    values[key] = value
target_path = Path(target)
if target_path.exists():
    for line in target_path.read_text().splitlines():
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        existing[key] = value
values.update({
    'APP_NAME': f'preview-{preview_env}',
    'DEPLOY_ENV': preview_env,
    'APP_PORT': preview_port,
    'APP_URL': f'https://{preview_host}',
    'POSTGRES_PASSWORD': secrets.token_urlsafe(24),
    'JWT_SECRET': secrets.token_urlsafe(48),
    'AUTH_SECRET': secrets.token_urlsafe(48),
    'TENANT_DATA_ENCRYPTION_KEY': secrets.token_urlsafe(48),
    'MEILISEARCH_MASTER_KEY': secrets.token_urlsafe(32),
})
if deploy_mode == 'config-restart':
    for key in [
        'POSTGRES_PASSWORD',
        'JWT_SECRET',
        'AUTH_SECRET',
        'TENANT_DATA_ENCRYPTION_KEY',
        'MEILISEARCH_MASTER_KEY',
    ]:
        if existing.get(key):
            values[key] = existing[key]
if preview_admin_email:
    values['OM_INIT_SUPERADMIN_EMAIL'] = preview_admin_email
    values['ADMIN_EMAIL'] = preview_admin_email
if preview_admin_password:
    values['OM_INIT_SUPERADMIN_PASSWORD'] = preview_admin_password
keys = [
    'APP_NAME','DEPLOY_ENV','APP_PORT','APP_URL','POSTGRES_USER','POSTGRES_PASSWORD','POSTGRES_DB',
    'JWT_SECRET','AUTH_SECRET','TENANT_DATA_ENCRYPTION_KEY','MEILISEARCH_MASTER_KEY',
    'SELF_SERVICE_ONBOARDING_ENABLED','DEMO_MODE','ADMIN_EMAIL','OM_INIT_SUPERADMIN_EMAIL',
    'OM_INIT_SUPERADMIN_PASSWORD','OPENAI_API_KEY','RESEND_API_KEY','EMAIL_FROM'
]
target_path.write_text('\n'.join(f'{key}={values[key]}' for key in keys if key in values) + '\n')
PY

cd "$workdir"
set -a
. ./.env
set +a

compose() {
  COMPOSE_BAKE=false COMPOSE_DOCKER_CLI_BUILD=0 DOCKER_BUILDKIT=0 docker compose --project-name "$preview_project" --env-file .env -f docker-compose.fullapp.yml "$@"
}

wait_for_local_login() {
  local url="http://127.0.0.1:${APP_PORT:-3000}/login"
  for attempt in $(seq 1 40); do
    status="$(curl -fsS -o /tmp/openmercato-preview-login.html -w '%{http_code}' "$url" 2>/dev/null || true)"
    if [[ "$status" =~ ^[23] ]]; then
      echo "Local preview login endpoint is reachable: ${url} (${status})"
      return 0
    fi
    echo "Waiting for local preview login endpoint (${attempt}/40): ${status:-no response}"
    sleep 5
  done
  cat /tmp/openmercato-preview-login.html 2>/dev/null || true
  echo "Preview app did not become reachable at ${url}" >&2
  return 1
}

post_deploy_cleanup() {
  echo "Post-deploy cleanup; app is already running:"
  df -h /
  timeout 30s docker system df || echo "docker system df skipped, failed, or timed out"
  timeout 6m docker builder prune -af || echo "docker builder prune skipped, failed, or timed out"
  timeout 3m docker image prune -f || echo "docker image prune skipped, failed, or timed out"
  echo "Post-deploy cleanup complete:"
  df -h /
  timeout 30s docker system df || echo "docker system df skipped, failed, or timed out"
}

if [[ "$deploy_mode" == "config-restart" ]]; then
  echo "Config-only deploy: skipping image build and restarting app with existing image."
  if ! timeout 30s docker image inspect "open-mercato/app:$preview_env" >/dev/null 2>&1; then
    echo "Missing existing image open-mercato/app:$preview_env; run a full deploy first." >&2
    exit 1
  fi
  compose up -d --no-deps --no-build --force-recreate app
else
  if ! timeout 30s docker image inspect opencode-mvp:latest >/dev/null 2>&1; then
    docker build -t opencode-mvp:latest docker/opencode
  fi
  build_log="/tmp/openmercato-preview-${preview_env}-build.log"
  rm -f "$build_log"
  echo "Building new app image while the current preview stays online."
  if ! DOCKER_BUILDKIT=1 BUILDKIT_PROGRESS=plain timeout 45m docker build --progress=plain \
    --build-arg CONTAINER_PORT="${CONTAINER_PORT:-3000}" \
    -t "open-mercato/app:$preview_env" \
    . >"$build_log" 2>&1; then
    tail -n 240 "$build_log" || true
    exit 1
  fi
  tail -n 80 "$build_log" || true
  echo "Recreating preview stack after successful image build."
  compose down --remove-orphans --volumes >/dev/null 2>&1 || true
  compose up -d --no-build --remove-orphans
fi
wait_for_local_login
post_deploy_cleanup

if [[ -n "$preview_admin_email" && -n "$preview_admin_password" && -n "$preview_admin_tenant_id" ]]; then
  bash ./infra/aws-upstream-baseline/reconcile-smoke-admin.sh \
    --workdir "$workdir" \
    --project-name "$preview_project" \
    --env-file "$workdir/.env" \
    --compose-file "$workdir/docker-compose.fullapp.yml" \
    --email "$preview_admin_email" \
    --password "$preview_admin_password" \
    --tenant-id "$preview_admin_tenant_id"
else
  echo "Skipping smoke-admin reconciliation (missing preview_admin_email/password/tenant_id)."
fi
EOF
} > "${REMOTE_SCRIPT}"

COMMANDS_JSON="$(python3 - <<'PY' "${REMOTE_SCRIPT}"
import json, sys
path = sys.argv[1]
print(json.dumps({'commands': [open(path, 'r', encoding='utf-8').read()]}))
PY
)"
COMMAND_ID="$(aws ssm send-command \
  --region "${AWS_REGION}" \
  --instance-ids "${PREVIEW_INSTANCE_ID}" \
  --document-name AWS-RunShellScript \
  --parameters "${COMMANDS_JSON}" \
  --query 'Command.CommandId' \
  --output text)"
wait_for_ssm_command "${COMMAND_ID}" "${PREVIEW_INSTANCE_ID}"
rm -f "${REMOTE_SCRIPT}"

TARGET_GROUP_ARN="$(aws elbv2 describe-target-groups --region "${AWS_REGION}" --names "${TARGET_GROUP_NAME}" --query 'TargetGroups[0].TargetGroupArn' --output text 2>/dev/null || true)"
if [[ -z "${TARGET_GROUP_ARN}" || "${TARGET_GROUP_ARN}" == "None" ]]; then
  TARGET_GROUP_ARN="$(aws elbv2 create-target-group \
    --region "${AWS_REGION}" \
    --name "${TARGET_GROUP_NAME}" \
    --protocol HTTP \
    --port "${PREVIEW_PORT}" \
    --vpc-id "${VPC_ID}" \
    --target-type instance \
    --health-check-protocol HTTP \
    --health-check-port "${PREVIEW_PORT}" \
    --health-check-path /login \
    --health-check-interval-seconds 15 \
    --health-check-timeout-seconds 10 \
    --healthy-threshold-count 2 \
    --unhealthy-threshold-count 2 \
    --matcher HttpCode=200-399 \
    --query 'TargetGroups[0].TargetGroupArn' \
    --output text)"
fi

aws elbv2 register-targets --region "${AWS_REGION}" --target-group-arn "${TARGET_GROUP_ARN}" --targets "Id=${PREVIEW_INSTANCE_ID},Port=${PREVIEW_PORT}" >/dev/null

RULE_ARN="$(existing_rule_arn_for_host "${PREVIEW_HOSTNAME}")"
if [[ -z "${RULE_ARN}" ]]; then
  PRIORITY="$(choose_rule_priority)"
  RULE_ARN="$(aws elbv2 create-rule \
    --region "${AWS_REGION}" \
    --listener-arn "${LISTENER_ARN}" \
    --priority "${PRIORITY}" \
    --conditions "[{\"Field\":\"host-header\",\"HostHeaderConfig\":{\"Values\":[\"${PREVIEW_HOSTNAME}\"]}}]" \
    --actions "[{\"Type\":\"forward\",\"TargetGroupArn\":\"${TARGET_GROUP_ARN}\"}]" \
    --query 'Rules[0].RuleArn' \
    --output text)"
else
  aws elbv2 modify-rule \
    --region "${AWS_REGION}" \
    --rule-arn "${RULE_ARN}" \
    --conditions "[{\"Field\":\"host-header\",\"HostHeaderConfig\":{\"Values\":[\"${PREVIEW_HOSTNAME}\"]}}]" \
    --actions "[{\"Type\":\"forward\",\"TargetGroupArn\":\"${TARGET_GROUP_ARN}\"}]" >/dev/null
fi

wait_for_target_healthy "${TARGET_GROUP_ARN}" 90
wait_for_http_200 "${PREVIEW_URL}/login" 90

echo "preview_branch=${BRANCH}"
echo "preview_slug=${PREVIEW_SLUG}"
echo "preview_hostname=${PREVIEW_HOSTNAME}"
echo "preview_url=${PREVIEW_URL}"
echo "preview_port=${PREVIEW_PORT}"
echo "preview_target_group_arn=${TARGET_GROUP_ARN}"
