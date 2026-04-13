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

PREVIEW_SLUG="$(branch_to_preview_slug "${BRANCH}")"
PREVIEW_HOSTNAME="$(preview_hostname_for_slug "${PREVIEW_SLUG}")"
PREVIEW_RUNTIME_ENV="$(preview_runtime_env_for_slug "${PREVIEW_SLUG}")"
TARGET_GROUP_NAME="$(target_group_name_for_slug "${PREVIEW_SLUG}")"
PREVIEW_PORT="$(choose_preview_port "${PREVIEW_SLUG}" "${TARGET_GROUP_NAME}")"
PREVIEW_ENV="${PREVIEW_RUNTIME_ENV}"
PREVIEW_PROJECT="preview-${PREVIEW_SLUG}"
PREVIEW_URL="https://${PREVIEW_HOSTNAME}"
REMOTE_WORKDIR="${PREVIEW_REMOTE_ROOT}/${PREVIEW_SLUG}"
PREVIEW_POSTGRES_CONTAINER="mercato-postgres-${PREVIEW_ENV}"

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
  printf 'baseline_seed_dump=%q\n' "${BASELINE_SEED_DUMP_REMOTE}"
  printf 'baseline_seed_metadata=%q\n' "${BASELINE_SEED_METADATA_REMOTE}"
  printf 'preview_postgres_container=%q\n' "${PREVIEW_POSTGRES_CONTAINER}"
  printf 'preview_admin_email=%q\n' "${PREVIEW_ADMIN_EMAIL:-${SMOKE_TEST_EMAIL:-}}"
  printf 'preview_admin_password=%q\n' "${PREVIEW_ADMIN_PASSWORD:-${SMOKE_TEST_PASSWORD:-}}"
  cat <<'INNER'
command -v git >/dev/null 2>&1 || { echo "Missing git on preview host" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "Missing docker on preview host" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "Missing python3 on preview host" >&2; exit 1; }

if [[ ! -f "$baseline_env_file" ]]; then
  echo "Missing baseline env file: $baseline_env_file" >&2
  exit 1
fi
if [[ ! -f "$baseline_seed_dump" ]]; then
  echo "Missing baseline seed dump: $baseline_seed_dump" >&2
  exit 1
fi
if [[ ! -f "$baseline_seed_metadata" ]]; then
  echo "Missing baseline seed metadata: $baseline_seed_metadata" >&2
  exit 1
fi

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
import secrets
import sys
from pathlib import Path

baseline, target, preview_env, preview_port, preview_host, preview_admin_email, preview_admin_password = sys.argv[1:8]
values = {}
for line in Path(baseline).read_text(encoding='utf-8').splitlines():
    if not line or line.startswith('#') or '=' not in line:
        continue
    key, value = line.split('=', 1)
    values[key] = value

baseline_encryption_key = values.get('TENANT_DATA_ENCRYPTION_KEY')
baseline_fallback_key = values.get('TENANT_DATA_ENCRYPTION_FALLBACK_KEY') or baseline_encryption_key
if not baseline_encryption_key:
    raise SystemExit('Baseline env is missing TENANT_DATA_ENCRYPTION_KEY')
if not baseline_fallback_key:
    raise SystemExit('Baseline env is missing a compatible tenant encryption fallback key')

values.update({
    'APP_NAME': f'preview-{preview_env}',
    'DEPLOY_ENV': preview_env,
    'APP_PORT': preview_port,
    'APP_URL': f'https://{preview_host}',
    'POSTGRES_PASSWORD': secrets.token_urlsafe(24),
    'JWT_SECRET': secrets.token_urlsafe(48),
    'AUTH_SECRET': secrets.token_urlsafe(48),
    'TENANT_DATA_ENCRYPTION_KEY': baseline_encryption_key,
    'TENANT_DATA_ENCRYPTION_FALLBACK_KEY': baseline_fallback_key,
    'MEILISEARCH_MASTER_KEY': secrets.token_urlsafe(32),
})
if preview_admin_email:
    values['OM_INIT_SUPERADMIN_EMAIL'] = preview_admin_email
    values['ADMIN_EMAIL'] = preview_admin_email
if preview_admin_password:
    values['OM_INIT_SUPERADMIN_PASSWORD'] = preview_admin_password
keys = [
    'APP_NAME', 'DEPLOY_ENV', 'APP_PORT', 'APP_URL', 'POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB',
    'JWT_SECRET', 'AUTH_SECRET', 'TENANT_DATA_ENCRYPTION_KEY', 'TENANT_DATA_ENCRYPTION_FALLBACK_KEY', 'MEILISEARCH_MASTER_KEY',
    'SELF_SERVICE_ONBOARDING_ENABLED', 'DEMO_MODE', 'ADMIN_EMAIL', 'OM_INIT_SUPERADMIN_EMAIL',
    'OM_INIT_SUPERADMIN_PASSWORD', 'OPENAI_API_KEY', 'RESEND_API_KEY', 'EMAIL_FROM'
]
Path(target).write_text('\n'.join(f'{key}={values[key]}' for key in keys if key in values) + '\n', encoding='utf-8')
PY

cd "$workdir"
docker compose --project-name "$preview_project" --env-file .env -f docker-compose.fullapp.yml down --remove-orphans --volumes >/dev/null 2>&1 || true
docker compose --project-name "$preview_project" --env-file .env -f docker-compose.fullapp.yml up -d postgres redis meilisearch

preview_postgres_password="$(grep '^POSTGRES_PASSWORD=' .env | head -n1 | cut -d= -f2-)"
preview_postgres_user="$(grep '^POSTGRES_USER=' .env | head -n1 | cut -d= -f2-)"
preview_postgres_db="$(grep '^POSTGRES_DB=' .env | head -n1 | cut -d= -f2-)"

for attempt in $(seq 1 30); do
  if docker exec "$preview_postgres_container" pg_isready -U "$preview_postgres_user" >/dev/null 2>&1; then
    break
  fi
  sleep 2
  if [[ "$attempt" == "30" ]]; then
    echo "Preview postgres did not become ready in time" >&2
    exit 1
  fi
done

docker cp "$baseline_seed_dump" "${preview_postgres_container}:/tmp/baseline-seed.dump"
docker exec -e PGPASSWORD="$preview_postgres_password" "$preview_postgres_container" psql -U "$preview_postgres_user" -d postgres -v ON_ERROR_STOP=1 -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$preview_postgres_db' AND pid <> pg_backend_pid();" -c "DROP DATABASE IF EXISTS \"$preview_postgres_db\";" -c "CREATE DATABASE \"$preview_postgres_db\";"
docker exec -e PGPASSWORD="$preview_postgres_password" "$preview_postgres_container" pg_restore -U "$preview_postgres_user" -d "$preview_postgres_db" --no-owner --no-acl /tmp/baseline-seed.dump
docker exec "$preview_postgres_container" rm -f /tmp/baseline-seed.dump >/dev/null 2>&1 || true

docker compose --project-name "$preview_project" --env-file .env -f docker-compose.fullapp.yml up -d --build
INNER
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
