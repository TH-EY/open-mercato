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
DEPLOY_MODE="${DEPLOY_MODE:-full}"
APP_IMAGE="${APP_IMAGE:-}"
REPO_URL="${REPO_URL:-https://github.com/TH-EY/open-mercato.git}"
APP_URL="${APP_URL:-https://crm.they.dev}"
APP_PORT="${APP_PORT:-3001}"

if [[ "${DEPLOY_MODE}" != "full" && "${DEPLOY_MODE}" != "config-restart" ]]; then
  echo "DEPLOY_MODE must be either 'full' or 'config-restart'" >&2
  exit 1
fi
if [[ "${DEPLOY_MODE}" == "full" && -z "${APP_IMAGE}" ]]; then
  echo "Set APP_IMAGE to the ECR image URI to deploy" >&2
  exit 1
fi

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
  printf 'deploy_mode=%q\n' "${DEPLOY_MODE}"
  printf 'app_image=%q\n' "${APP_IMAGE}"
  printf 'app_url=%q\n' "${APP_URL}"
  printf 'app_port=%q\n' "${APP_PORT}"
  cat <<'EOF_REMOTE_BODY'
export AWS_REGION="$aws_region"
workdir=/opt/openmercato-crm
mkdir -p "$workdir"

secret_value() {
  aws secretsmanager get-secret-value --region "$aws_region" --secret-id "$1" --query SecretString --output text
}

param_value() {
  aws ssm get-parameter --region "$aws_region" --name "$1" --query Parameter.Value --output text
}

if [[ ! -d "$workdir/.git" ]]; then
  if [[ "$deploy_mode" == "config-restart" ]]; then
    echo "Config-only deploy requires an existing CRM checkout at ${workdir}" >&2
    exit 1
  fi
  rm -rf "$workdir"
  git clone --branch "$branch" --single-branch "$repo_url" "$workdir"
else
  git -C "$workdir" remote set-url origin "$repo_url"
  git -C "$workdir" fetch origin "+refs/heads/$branch:refs/remotes/origin/$branch" --prune
  git -C "$workdir" checkout -B "$branch" "refs/remotes/origin/$branch"
  git -C "$workdir" reset --hard "refs/remotes/origin/$branch"
  git -C "$workdir" clean -fdx -e .env.crm
fi

if [[ "$deploy_mode" == "full" ]]; then
  account_id="$(aws sts get-caller-identity --query Account --output text)"
  aws ecr get-login-password --region "$aws_region" | docker login --username AWS --password-stdin "${account_id}.dkr.ecr.${aws_region}.amazonaws.com" >/dev/null
else
  existing_app_image="$(awk -F= '$1=="APP_IMAGE"{print substr($0, index($0, "=") + 1)}' "$workdir/.env.crm" 2>/dev/null || true)"
  app_image="${app_image:-$existing_app_image}"
  if [[ -z "$app_image" ]]; then
    echo "Config-only deploy cannot determine APP_IMAGE from ${workdir}/.env.crm" >&2
    exit 1
  fi
fi

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
wait_for_local_login() {
  local url="http://127.0.0.1:${APP_PORT:-3001}/login"
  for attempt in $(seq 1 40); do
    status="$(curl -fsS -o /tmp/openmercato-crm-login.html -w '%{http_code}' "$url" 2>/dev/null || true)"
    if [[ "$status" =~ ^[23] ]]; then
      echo "Local CRM login endpoint is reachable: ${url} (${status})"
      return 0
    fi
    echo "Waiting for local CRM login endpoint (${attempt}/40): ${status:-no response}"
    sleep 5
  done
  cat /tmp/openmercato-crm-login.html 2>/dev/null || true
  echo "CRM app did not become reachable at ${url}" >&2
  return 1
}

if [[ "$deploy_mode" == "config-restart" ]]; then
  echo "Config-only CRM deploy: skipping image pull and recreating app/worker with existing image."
  docker compose --env-file .env.crm -f docker-compose.crm.yml up -d --no-build --force-recreate app worker
else
  docker compose --env-file .env.crm -f docker-compose.crm.yml pull
  docker compose --env-file .env.crm -f docker-compose.crm.yml up -d --remove-orphans
fi
wait_for_local_login

docker ps --filter name=openmercato-crm --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
EOF_REMOTE_BODY
  echo 'EOF_REMOTE_CRM_DEPLOY'
} > "${REMOTE_SCRIPT}"

COMMANDS_JSON="$(python3 - <<'PY' "${REMOTE_SCRIPT}"
import json, sys
print(json.dumps({'commands': [open(sys.argv[1], encoding='utf-8').read()]}))
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
