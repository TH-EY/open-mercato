#!/usr/bin/env bash
set -euo pipefail

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

require_cmd aws
require_cmd jq

export AWS_PAGER=""
AWS_REGION="${AWS_REGION:-eu-west-2}"
NAME_PREFIX="${NAME_PREFIX:-openmercato-crm-they-dev}"
BRANCH="${BRANCH:-fork/crm-they-dev}"
APP_IMAGE="${APP_IMAGE:?Set APP_IMAGE to the ECR image URI to deploy}"
REPO_URL="${REPO_URL:-https://github.com/TH-EY/open-mercato.git}"
APP_URL="${APP_URL:-https://crm.they.dev}"
APP_PORT="${APP_PORT:-3001}"

if [[ "${AWS_REGION}" != "eu-west-2" ]]; then
  echo "crm.they.dev must be deployed in AWS London (eu-west-2)." >&2
  exit 1
fi

INSTANCE_ID="$(aws ec2 describe-instances \
  --region "${AWS_REGION}" \
  --filters "Name=tag:Name,Values=${NAME_PREFIX}" "Name=instance-state-name,Values=running" \
  --query 'Reservations[0].Instances[0].InstanceId' \
  --output text)"

if [[ -z "${INSTANCE_ID}" || "${INSTANCE_ID}" == "None" ]]; then
  echo "No running EC2 instance found for ${NAME_PREFIX}. Run Terraform first." >&2
  exit 1
fi

REMOTE_SCRIPT="$(mktemp)"
{
  echo "bash <<'EOF_REMOTE_CRM_DEPLOY'"
  echo 'set -euo pipefail'
  printf 'aws_region=%q\n' "${AWS_REGION}"
  printf 'name_prefix=%q\n' "${NAME_PREFIX}"
  printf 'branch=%q\n' "${BRANCH}"
  printf 'repo_url=%q\n' "${REPO_URL}"
  printf 'app_image=%q\n' "${APP_IMAGE}"
  printf 'app_url=%q\n' "${APP_URL}"
  printf 'app_port=%q\n' "${APP_PORT}"
  cat <<'EOF_REMOTE_BODY'
export AWS_REGION="$aws_region"
workdir=/opt/openmercato-crm
mkdir -p "$workdir"

while true; do
  echo "[crm-deploy] still running $(date -Is)"
  sleep 60
done &
heartbeat_pid="$!"
trap 'kill "$heartbeat_pid" >/dev/null 2>&1 || true' EXIT

secret_value() {
  aws secretsmanager get-secret-value --region "$aws_region" --secret-id "$1" --query SecretString --output text
}

param_value() {
  aws ssm get-parameter --region "$aws_region" --name "$1" --query Parameter.Value --output text
}

if [[ ! -d "$workdir/.git" ]]; then
  rm -rf "$workdir"
  git clone --branch "$branch" --single-branch "$repo_url" "$workdir"
else
  git -C "$workdir" remote set-url origin "$repo_url"
  git -C "$workdir" fetch origin "refs/heads/${branch}:refs/remotes/origin/${branch}" --prune
  git -C "$workdir" checkout -B "$branch" "origin/$branch"
  git -C "$workdir" reset --hard "origin/$branch"
  git -C "$workdir" clean -fdx
fi

account_id="$(aws sts get-caller-identity --query Account --output text)"
aws ecr get-login-password --region "$aws_region" | docker login --username AWS --password-stdin "${account_id}.dkr.ecr.${aws_region}.amazonaws.com" >/dev/null

database_url="$(secret_value "${name_prefix}/database-url")"
jwt_secret="$(secret_value "${name_prefix}/jwt-secret")"
tenant_key="$(secret_value "${name_prefix}/tenant-data-encryption-key")"
meili_key="$(secret_value "${name_prefix}/meilisearch-master-key")"
admin_password="$(secret_value "${name_prefix}/initial-admin-password")"
admin_email="$(param_value "/${name_prefix}/runtime/admin-email")"

cat > "$workdir/.env.crm" <<ENV_CRM
APP_IMAGE=$app_image
APP_URL=$app_url
APP_PORT=$app_port
CONTAINER_PORT=3000
SYSTEM_EMAIL_PROVIDER=ses
AWS_SES_REGION=$aws_region
AWS_REGION=$aws_region
EMAIL_FROM=no-reply@they.dev
NOTIFICATIONS_EMAIL_FROM=no-reply@they.dev
DATABASE_URL=$database_url
JWT_SECRET=$jwt_secret
TENANT_DATA_ENCRYPTION_KEY=$tenant_key
MEILISEARCH_MASTER_KEY=$meili_key
OM_INIT_SUPERADMIN_EMAIL=$admin_email
OM_INIT_SUPERADMIN_PASSWORD=$admin_password
WEB_DB_POOL_MIN=0
WEB_DB_POOL_MAX=12
WORKER_DB_POOL_MIN=0
WORKER_DB_POOL_MAX=4
DB_POOL_IDLE_TIMEOUT=30000
DB_POOL_ACQUIRE_TIMEOUT=60000
DATA_SYNC_QUEUE_CONCURRENCY=1
ENV_CRM

cd "$workdir"
docker compose --env-file .env.crm -f docker-compose.crm.yml pull
docker compose --env-file .env.crm -f docker-compose.crm.yml up -d --remove-orphans

docker ps --filter name=openmercato-crm --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
EOF_REMOTE_BODY
  echo 'EOF_REMOTE_CRM_DEPLOY'
} > "${REMOTE_SCRIPT}"

COMMANDS_JSON="$(python3 - <<'PY' "${REMOTE_SCRIPT}"
import json, sys
print(json.dumps({
  'commands': [open(sys.argv[1], encoding='utf-8').read()],
  'executionTimeout': ['1800'],
}))
PY
)"

COMMAND_ID="$(aws ssm send-command \
  --region "${AWS_REGION}" \
  --instance-ids "${INSTANCE_ID}" \
  --document-name AWS-RunShellScript \
  --comment "Deploy Open Mercato CRM" \
  --parameters "${COMMANDS_JSON}" \
  --query 'Command.CommandId' \
  --output text)"

rm -f "${REMOTE_SCRIPT}"

echo "SSM command: ${COMMAND_ID}"

DEADLINE_SECONDS="${SSM_WAIT_DEADLINE_SECONDS:-1200}"
POLL_INTERVAL_SECONDS="${SSM_WAIT_POLL_INTERVAL_SECONDS:-15}"
deadline=$((SECONDS + DEADLINE_SECONDS))
status="Pending"
invocation_json=""

while ((SECONDS < deadline)); do
  if invocation_json="$(aws ssm get-command-invocation \
    --region "${AWS_REGION}" \
    --command-id "${COMMAND_ID}" \
    --instance-id "${INSTANCE_ID}" \
    --query '{Status:Status,ResponseCode:ResponseCode,Stdout:StandardOutputContent,Stderr:StandardErrorContent}' \
    --output json 2>/tmp/openmercato-crm-ssm-get-command.err)"; then
    status="$(jq -r '.Status' <<<"${invocation_json}")"
  else
    status="Pending"
  fi

  case "${status}" in
  Success | Cancelled | TimedOut | Failed | Cancelling)
    break
    ;;
  esac

  sleep "${POLL_INTERVAL_SECONDS}"
done

if [[ -z "${invocation_json}" ]]; then
  echo "Timed out waiting for SSM command ${COMMAND_ID}; no invocation details were available." >&2
  if [[ -s /tmp/openmercato-crm-ssm-get-command.err ]]; then
    cat /tmp/openmercato-crm-ssm-get-command.err >&2
  fi
  exit 1
fi

echo "${invocation_json}"

if [[ "${status}" != "Success" ]]; then
  echo "SSM command ${COMMAND_ID} finished with status ${status}." >&2
  exit 1
fi
