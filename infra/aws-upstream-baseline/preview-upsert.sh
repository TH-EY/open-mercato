#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./preview-common.sh
source "${SCRIPT_DIR}/preview-common.sh"

BRANCH="${1:-${BRANCH:-${GITHUB_REF_NAME:-}}}"
if [[ -z "${BRANCH}" ]]; then
  echo "Usage: $0 <contrib/branch-name|fork/EPC>" >&2
  exit 1
fi
if [[ "${BRANCH}" != contrib/* && "${BRANCH}" != "fork/EPC" ]]; then
  echo "Preview deployments are only supported for contrib/* branches and fork/EPC" >&2
  exit 1
fi

PREVIEW_SLUG="$(branch_to_preview_slug "${BRANCH}")"
PREVIEW_HOSTNAME="$(preview_hostname_for_slug "${PREVIEW_SLUG}")"
PREVIEW_RUNTIME_ENV="$(preview_runtime_env_for_slug "${PREVIEW_SLUG}")"
TARGET_GROUP_NAME="$(target_group_name_for_slug "${PREVIEW_SLUG}")"
echo "Preparing preview ${PREVIEW_SLUG} for ${BRANCH}"
echo "Resolving preview port for ${PREVIEW_HOSTNAME}"
PREVIEW_PORT="$(choose_preview_port "${PREVIEW_SLUG}" "${TARGET_GROUP_NAME}")"
PREVIEW_ENV="${PREVIEW_RUNTIME_ENV}"
PREVIEW_PROJECT="preview-${PREVIEW_SLUG}"
PREVIEW_URL="https://${PREVIEW_HOSTNAME}"
REMOTE_WORKDIR="${PREVIEW_REMOTE_ROOT}/${PREVIEW_SLUG}"
echo "Preview port resolved: ${PREVIEW_PORT}"

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
  printf 'workdir=%q\n' "${REMOTE_WORKDIR}"
  printf 'remote_root=%q\n' "${PREVIEW_REMOTE_ROOT}"
  printf 'baseline_env_file=%q\n' "${BASELINE_ENV_FILE_REMOTE}"
  printf 'preview_admin_email=%q\n' "${PREVIEW_ADMIN_EMAIL:-${SMOKE_TEST_EMAIL:-}}"
  printf 'preview_admin_password=%q\n' "${PREVIEW_ADMIN_PASSWORD:-${SMOKE_TEST_PASSWORD:-}}"
  cat <<'EOF'
command -v git >/dev/null 2>&1 || { echo "Missing git on preview host" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "Missing docker on preview host" >&2; exit 1; }

mkdir -p "$remote_root"
if [[ ! -d "$workdir/.git" ]]; then
  git clone --branch "$branch" --single-branch "$repo_url" "$workdir"
else
  git -C "$workdir" remote set-url origin "$repo_url"
  git -C "$workdir" fetch origin "$branch" --prune
  git -C "$workdir" checkout -B "$branch" "origin/$branch"
  git -C "$workdir" reset --hard "origin/$branch"
  git -C "$workdir" clean -fdx
fi

python3 - <<'PY' "$baseline_env_file" "$workdir/.env" "$preview_env" "$preview_port" "$preview_hostname" "$preview_admin_email" "$preview_admin_password"
import secrets, sys
from pathlib import Path
baseline, target, preview_env, preview_port, preview_host, preview_admin_email, preview_admin_password = sys.argv[1:8]
values = {}
for line in Path(baseline).read_text().splitlines():
    if not line or line.startswith('#') or '=' not in line:
        continue
    key, value = line.split('=', 1)
    values[key] = value
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
if preview_host == 'preview-epc.om.they.dev':
    values.update({
        'SYSTEM_EMAIL_PROVIDER': 'ses',
        'AWS_SES_REGION': values.get('AWS_SES_REGION') or values.get('AWS_REGION') or 'eu-west-2',
        'EMAIL_FROM': values.get('EMAIL_FROM') or 'no-reply@they.dev',
        'NOTIFICATIONS_EMAIL_FROM': values.get('NOTIFICATIONS_EMAIL_FROM') or values.get('EMAIL_FROM') or 'no-reply@they.dev',
    })
if preview_admin_email:
    values['OM_INIT_SUPERADMIN_EMAIL'] = preview_admin_email
    values['ADMIN_EMAIL'] = preview_admin_email
if preview_admin_password:
    values['OM_INIT_SUPERADMIN_PASSWORD'] = preview_admin_password
keys = [
    'APP_NAME','DEPLOY_ENV','APP_PORT','APP_URL','POSTGRES_USER','POSTGRES_PASSWORD','POSTGRES_DB',
    'JWT_SECRET','AUTH_SECRET','TENANT_DATA_ENCRYPTION_KEY','MEILISEARCH_MASTER_KEY',
    'SELF_SERVICE_ONBOARDING_ENABLED','DEMO_MODE','ADMIN_EMAIL','OM_INIT_SUPERADMIN_EMAIL',
    'OM_INIT_SUPERADMIN_PASSWORD','OPENAI_API_KEY','SYSTEM_EMAIL_PROVIDER','AWS_SES_REGION',
    'AWS_SES_CONFIGURATION_SET','RESEND_API_KEY','EMAIL_FROM','NOTIFICATIONS_EMAIL_FROM'
]
Path(target).write_text('\n'.join(f'{key}={values[key]}' for key in keys if key in values) + '\n')
PY

cd "$workdir"
if [[ "$branch" == "fork/EPC" ]]; then
  echo "EPC pre-build cleanup before build:"
  df -h /
  timeout 30s docker system df || echo "docker system df skipped, failed, or timed out"
  timeout 6m docker builder prune -af || echo "docker builder prune skipped, failed, or timed out"
  timeout 3m docker image prune -f || echo "docker image prune skipped, failed, or timed out"
  echo "EPC pre-build cleanup after cleanup:"
  df -h /
  timeout 30s docker system df || echo "docker system df skipped, failed, or timed out"
fi
if [[ "$branch" != "fork/EPC" ]]; then
  docker compose --project-name "$preview_project" --env-file .env -f docker-compose.fullapp.yml down --remove-orphans --volumes >/dev/null 2>&1 || true
fi
if ! timeout 30s docker image inspect opencode-mvp:latest >/dev/null 2>&1; then
  docker build -t opencode-mvp:latest docker/opencode
fi
build_log="/tmp/openmercato-preview-${preview_env}-build.log"
rm -f "$build_log"
if ! DOCKER_BUILDKIT=1 BUILDKIT_PROGRESS=plain timeout 45m docker build --progress=plain \
  --build-arg CONTAINER_PORT="${CONTAINER_PORT:-3000}" \
  -t "open-mercato/app:$preview_env" \
  . >"$build_log" 2>&1; then
  tail -n 240 "$build_log" || true
  exit 1
fi
tail -n 80 "$build_log" || true
if [[ "$branch" == "fork/EPC" ]]; then
  # Keep EPC online while the slow image build runs. The data reset still happens
  # before the new stack starts, but the cancellation window is short.
  docker compose --project-name "$preview_project" --env-file .env -f docker-compose.fullapp.yml down --remove-orphans --volumes >/dev/null 2>&1 || true
fi
COMPOSE_BAKE=false COMPOSE_DOCKER_CLI_BUILD=0 DOCKER_BUILDKIT=0 docker compose --project-name "$preview_project" --env-file .env -f docker-compose.fullapp.yml up -d --no-build
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
echo "SSM deploy command sent: ${COMMAND_ID}"
wait_for_ssm_command "${COMMAND_ID}" "${PREVIEW_INSTANCE_ID}"
echo "SSM deploy command completed: ${COMMAND_ID}"
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
echo "Registered preview target on port ${PREVIEW_PORT}"

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
echo "Target group is healthy"
wait_for_http_200 "${PREVIEW_URL}/login" 90
echo "Preview login endpoint is reachable"

echo "preview_branch=${BRANCH}"
echo "preview_slug=${PREVIEW_SLUG}"
echo "preview_hostname=${PREVIEW_HOSTNAME}"
echo "preview_url=${PREVIEW_URL}"
echo "preview_port=${PREVIEW_PORT}"
echo "preview_target_group_arn=${TARGET_GROUP_ARN}"
