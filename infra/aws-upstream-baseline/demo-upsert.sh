#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./preview-common.sh
source "${SCRIPT_DIR}/preview-common.sh"

DEMO_NAME="${1:-${DEMO_NAME:-}}"
DEMO_BRANCH="${2:-${DEMO_BRANCH:-upstream-baseline}}"
if [[ -z "${DEMO_NAME}" ]]; then
  echo "Usage: $0 <demo-name> [git-branch]" >&2
  exit 1
fi

DEMO_SLUG="$(python3 - <<'PY' "${DEMO_NAME}"
import re, sys
base = sys.argv[1].lower()
base = re.sub(r'[^a-z0-9]+', '-', base).strip('-')
if not base:
    raise SystemExit('Demo name must contain at least one letter or digit')
print(base[:50].strip('-'))
PY
)"
if [[ "${DEMO_SLUG}" != "${DEMO_NAME}" ]]; then
  echo "Normalized demo name '${DEMO_NAME}' to '${DEMO_SLUG}'" >&2
fi

DEMO_HOSTNAME="${DEMO_HOSTNAME:-${DEMO_SLUG}.${PREVIEW_HOST_SUFFIX}}"
DEMO_PROJECT="demo-${DEMO_SLUG}"
DEMO_ENV="demo-${DEMO_SLUG}"
DEMO_URL="https://${DEMO_HOSTNAME}"
DEMO_REMOTE_ROOT="${DEMO_REMOTE_ROOT:-/opt/openmercato-demos}"
DEMO_WORKDIR="${DEMO_REMOTE_ROOT}/${DEMO_SLUG}"
DEMO_REPO_URL="${DEMO_REPO_URL:-${PREVIEW_REPO_URL}}"
DEMO_REUSE_BASELINE_IMAGE="${DEMO_REUSE_BASELINE_IMAGE:-true}"
BASELINE_IMAGE_TAG="${BASELINE_IMAGE_TAG:-upstream-baseline}"
DEMO_APP_IMAGE="${DEMO_APP_IMAGE:-}"
DEMO_DOCKER_REGISTRY="${DEMO_DOCKER_REGISTRY:-}"
DEMO_DOCKER_USERNAME="${DEMO_DOCKER_USERNAME:-AWS}"
DEMO_DOCKER_PASSWORD="${DEMO_DOCKER_PASSWORD:-}"
TARGET_GROUP_NAME="$(python3 - <<'PY' "${DEMO_SLUG}"
import hashlib, sys
print(f"om-demo-{hashlib.sha1(sys.argv[1].encode()).hexdigest()[:9]}")
PY
)"

used_dokploy_ports() {
  local target_groups_json
  target_groups_json="$(aws elbv2 describe-target-groups --region "${AWS_REGION}" --output json)"
  python3 - <<'PY' "${PREVIEW_PORT_MIN}" "${PREVIEW_PORT_MAX}" "${target_groups_json}"
import json, sys
low, high = int(sys.argv[1]), int(sys.argv[2])
data = json.loads(sys.argv[3])
for item in data.get('TargetGroups', []):
    port = int(item.get('Port') or 0)
    if low <= port <= high:
        print(port)
PY
}

choose_demo_port() {
  local slug="$1"
  local tg_name="$2"
  local existing_port
  existing_port="$(aws elbv2 describe-target-groups --region "${AWS_REGION}" --names "${tg_name}" --query 'TargetGroups[0].Port' --output text 2>/dev/null || true)"
  if [[ -n "${existing_port}" && "${existing_port}" != "None" ]]; then
    echo "${existing_port}"
    return 0
  fi

  python3 - <<'PY' "${slug}" "${PREVIEW_PORT_MIN}" "${PREVIEW_PORT_MAX}" "$(used_dokploy_ports | tr '\n' ' ')"
import hashlib, sys
slug = sys.argv[1]
port_min = int(sys.argv[2])
port_max = int(sys.argv[3])
used = {int(x) for x in sys.argv[4].split() if x.strip()}
span = port_max - port_min + 1
start = port_min + (int(hashlib.sha1(slug.encode()).hexdigest()[:8], 16) % span)
for offset in range(span):
    candidate = port_min + ((start - port_min + offset) % span)
    if candidate not in used:
        print(candidate)
        break
else:
    raise SystemExit('No free demo port available')
PY
}

DEMO_PORT="$(choose_demo_port "${DEMO_SLUG}" "${TARGET_GROUP_NAME}")"

REMOTE_SCRIPT="$(mktemp)"
{
  echo "bash <<'EOF_DEMO_UPSERT_BASH'"
  echo 'set -euo pipefail'
  printf 'branch=%q\n' "${DEMO_BRANCH}"
  printf 'repo_url=%q\n' "${DEMO_REPO_URL}"
  printf 'demo_env=%q\n' "${DEMO_ENV}"
  printf 'demo_project=%q\n' "${DEMO_PROJECT}"
  printf 'demo_hostname=%q\n' "${DEMO_HOSTNAME}"
  printf 'demo_port=%q\n' "${DEMO_PORT}"
  printf 'workdir=%q\n' "${DEMO_WORKDIR}"
  printf 'remote_root=%q\n' "${DEMO_REMOTE_ROOT}"
  printf 'baseline_env_file=%q\n' "${BASELINE_ENV_FILE_REMOTE}"
  printf 'demo_admin_email=%q\n' "${DEMO_ADMIN_EMAIL:-${SMOKE_TEST_EMAIL:-}}"
  printf 'demo_admin_password=%q\n' "${DEMO_ADMIN_PASSWORD:-${SMOKE_TEST_PASSWORD:-}}"
  printf 'demo_admin_tenant_id=%q\n' "${DEMO_ADMIN_TENANT_ID:-${SMOKE_TEST_TENANT_ID:-}}"
  printf 'reuse_baseline_image=%q\n' "${DEMO_REUSE_BASELINE_IMAGE}"
  printf 'baseline_image_tag=%q\n' "${BASELINE_IMAGE_TAG}"
  printf 'demo_app_image=%q\n' "${DEMO_APP_IMAGE}"
  printf 'demo_docker_registry=%q\n' "${DEMO_DOCKER_REGISTRY}"
  printf 'demo_docker_username=%q\n' "${DEMO_DOCKER_USERNAME}"
  printf 'demo_docker_password=%q\n' "${DEMO_DOCKER_PASSWORD}"
  cat <<'EOF_REMOTE'
command -v git >/dev/null 2>&1 || { echo "Missing git on demo host" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "Missing docker on demo host" >&2; exit 1; }
export GIT_TERMINAL_PROMPT=0


mkdir -p "$remote_root"
if [[ -e "$workdir" && ! -d "$workdir/.git" ]]; then
  echo "Removing incomplete non-git demo workdir: $workdir" >&2
  rm -rf "$workdir"
fi
existing_env=""
if [[ -f "$workdir/.env" ]]; then
  existing_env="$(mktemp)"
  cp "$workdir/.env" "$existing_env"
fi

if [[ ! -d "$workdir/.git" ]]; then
  timeout 300 git clone --branch "$branch" --single-branch "$repo_url" "$workdir"
else
  git -C "$workdir" remote set-url origin "$repo_url"
  timeout 300 git -C "$workdir" fetch origin "$branch" --prune
  git -C "$workdir" checkout -B "$branch" FETCH_HEAD
  git -C "$workdir" reset --hard FETCH_HEAD
  git -C "$workdir" clean -fdx
fi

if [[ -n "$existing_env" ]]; then
  cp "$existing_env" "$workdir/.env"
  rm -f "$existing_env"
fi

python3 - <<'PY' "$baseline_env_file" "$workdir/.env" "$demo_env" "$demo_port" "$demo_hostname" "$demo_admin_email" "$demo_admin_password"
import secrets, sys
from pathlib import Path
baseline, target, demo_env, demo_port, demo_host, demo_admin_email, demo_admin_password = sys.argv[1:8]
values = {}
for source in (Path(baseline), Path(target)):
    if not source.exists():
        continue
    for line in source.read_text().splitlines():
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        values[key] = value

def keep_or_generate(key, size):
    if not values.get(key):
        values[key] = secrets.token_urlsafe(size)

values.update({
    'APP_NAME': demo_env,
    'DEPLOY_ENV': demo_env,
    'APP_PORT': demo_port,
    'APP_URL': f'https://{demo_host}',
})
keep_or_generate('POSTGRES_PASSWORD', 24)
keep_or_generate('JWT_SECRET', 48)
keep_or_generate('AUTH_SECRET', 48)
keep_or_generate('TENANT_DATA_ENCRYPTION_KEY', 48)
keep_or_generate('MEILISEARCH_MASTER_KEY', 32)
if demo_admin_email:
    values['OM_INIT_SUPERADMIN_EMAIL'] = demo_admin_email
    values['ADMIN_EMAIL'] = demo_admin_email
if demo_admin_password:
    values['OM_INIT_SUPERADMIN_PASSWORD'] = demo_admin_password
keys = [
    'APP_NAME','DEPLOY_ENV','APP_PORT','APP_URL','POSTGRES_USER','POSTGRES_PASSWORD','POSTGRES_DB',
    'JWT_SECRET','AUTH_SECRET','TENANT_DATA_ENCRYPTION_KEY','MEILISEARCH_MASTER_KEY',
    'SELF_SERVICE_ONBOARDING_ENABLED','DEMO_MODE','ADMIN_EMAIL','OM_INIT_SUPERADMIN_EMAIL',
    'OM_INIT_SUPERADMIN_PASSWORD','OPENAI_API_KEY','RESEND_API_KEY','EMAIL_FROM'
]
Path(target).write_text('\n'.join(f'{key}={values[key]}' for key in keys if key in values) + '\n')
PY

cd "$workdir"
if [[ -n "$demo_app_image" ]]; then
  if [[ -n "$demo_docker_registry" && -n "$demo_docker_password" ]]; then
    printf '%s' "$demo_docker_password" | docker login "$demo_docker_registry" --username "$demo_docker_username" --password-stdin >/dev/null
  fi
  docker pull "$demo_app_image"
  docker tag "$demo_app_image" "open-mercato/app:${demo_env}"
  docker compose --project-name "$demo_project" --env-file .env -f docker-compose.fullapp.yml up -d --no-build --remove-orphans
  if [[ -n "$demo_docker_registry" && -n "$demo_docker_password" ]]; then
    docker logout "$demo_docker_registry" >/dev/null 2>&1 || true
  fi
elif [[ "$reuse_baseline_image" == "true" ]]; then
  if ! docker image inspect "open-mercato/app:${baseline_image_tag}" >/dev/null 2>&1; then
    echo "Baseline image open-mercato/app:${baseline_image_tag} is missing; falling back to build." >&2
    timeout 3600 docker compose --project-name "$demo_project" --env-file .env -f docker-compose.fullapp.yml up -d --build --remove-orphans
  else
    docker tag "open-mercato/app:${baseline_image_tag}" "open-mercato/app:${demo_env}"
    docker compose --project-name "$demo_project" --env-file .env -f docker-compose.fullapp.yml up -d --no-build --remove-orphans
  fi
else
  timeout 3600 docker compose --project-name "$demo_project" --env-file .env -f docker-compose.fullapp.yml up -d --build --remove-orphans
fi

if [[ -n "$demo_admin_email" && -n "$demo_admin_password" && -n "$demo_admin_tenant_id" ]]; then
  bash ./infra/aws-upstream-baseline/reconcile-smoke-admin.sh \
    --workdir "$workdir" \
    --project-name "$demo_project" \
    --env-file "$workdir/.env" \
    --compose-file "$workdir/docker-compose.fullapp.yml" \
    --email "$demo_admin_email" \
    --password "$demo_admin_password" \
    --tenant-id "$demo_admin_tenant_id"
else
  echo "Skipping demo admin reconciliation (missing demo_admin_email/password/tenant_id)."
fi
EOF_REMOTE
  echo 'EOF_DEMO_UPSERT_BASH'
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
    --port "${DEMO_PORT}" \
    --vpc-id "${VPC_ID}" \
    --target-type instance \
    --health-check-protocol HTTP \
    --health-check-port "${DEMO_PORT}" \
    --health-check-path /login \
    --health-check-interval-seconds 15 \
    --health-check-timeout-seconds 10 \
    --healthy-threshold-count 2 \
    --unhealthy-threshold-count 2 \
    --matcher HttpCode=200-399 \
    --query 'TargetGroups[0].TargetGroupArn' \
    --output text)"
fi

aws elbv2 register-targets --region "${AWS_REGION}" --target-group-arn "${TARGET_GROUP_ARN}" --targets "Id=${PREVIEW_INSTANCE_ID},Port=${DEMO_PORT}" >/dev/null

RULE_ARN="$(existing_rule_arn_for_host "${DEMO_HOSTNAME}")"
if [[ -z "${RULE_ARN}" ]]; then
  PRIORITY="$(choose_rule_priority)"
  RULE_ARN="$(aws elbv2 create-rule \
    --region "${AWS_REGION}" \
    --listener-arn "${LISTENER_ARN}" \
    --priority "${PRIORITY}" \
    --conditions "[{\"Field\":\"host-header\",\"HostHeaderConfig\":{\"Values\":[\"${DEMO_HOSTNAME}\"]}}]" \
    --actions "[{\"Type\":\"forward\",\"TargetGroupArn\":\"${TARGET_GROUP_ARN}\"}]" \
    --query 'Rules[0].RuleArn' \
    --output text)"
else
  aws elbv2 modify-rule \
    --region "${AWS_REGION}" \
    --rule-arn "${RULE_ARN}" \
    --conditions "[{\"Field\":\"host-header\",\"HostHeaderConfig\":{\"Values\":[\"${DEMO_HOSTNAME}\"]}}]" \
    --actions "[{\"Type\":\"forward\",\"TargetGroupArn\":\"${TARGET_GROUP_ARN}\"}]" >/dev/null
fi

wait_for_target_healthy "${TARGET_GROUP_ARN}" 90
wait_for_http_200 "${DEMO_URL}/login" 90

echo "demo_name=${DEMO_SLUG}"
echo "demo_branch=${DEMO_BRANCH}"
echo "demo_hostname=${DEMO_HOSTNAME}"
echo "demo_url=${DEMO_URL}"
echo "demo_port=${DEMO_PORT}"
echo "demo_target_group_arn=${TARGET_GROUP_ARN}"
