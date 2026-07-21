#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./preview-common.sh
source "${SCRIPT_DIR}/preview-common.sh"

BRANCH="${1:-${BRANCH:-${GITHUB_REF_NAME:-}}}"
if [[ -z "${BRANCH}" ]]; then
  echo "Usage: $0 <contrib/branch-name|fork/EPC|fork/manoj>" >&2
  exit 1
fi
if [[ "${BRANCH}" != contrib/* && "${BRANCH}" != "fork/EPC" && "${BRANCH}" != "fork/manoj" ]]; then
  echo "Deployments are only supported for contrib/* branches, fork/EPC, and fork/manoj" >&2
  exit 1
fi
DEPLOY_MODE="${DEPLOY_MODE:-full}"
if [[ "${DEPLOY_MODE}" != "full" && "${DEPLOY_MODE}" != "config-restart" ]]; then
  echo "DEPLOY_MODE must be either 'full' or 'config-restart'" >&2
  exit 1
fi

PREVIEW_SLUG="$(branch_to_preview_slug "${BRANCH}")"
PREVIEW_HOSTNAME="$(preview_hostname_for_slug "${PREVIEW_SLUG}")"
PREVIEW_RUNTIME_ENV="$(preview_runtime_env_for_slug "${PREVIEW_SLUG}")"
TARGET_GROUP_NAME="$(target_group_name_for_slug "${PREVIEW_SLUG}")"
echo "Preparing deployment ${PREVIEW_SLUG} for ${BRANCH}"
echo "Deploy mode: ${DEPLOY_MODE}"
echo "Resolving port for ${PREVIEW_HOSTNAME}"
PREVIEW_PORT="$(choose_preview_port "${PREVIEW_SLUG}" "${TARGET_GROUP_NAME}")"
PREVIEW_ENV="${PREVIEW_RUNTIME_ENV}"
PREVIEW_PROJECT="preview-${PREVIEW_SLUG}"
REMOTE_ROOT="${PREVIEW_REMOTE_ROOT}"
if [[ "${PREVIEW_SLUG}" == "manoj" ]]; then
  PREVIEW_PROJECT="demo-manoj"
  REMOTE_ROOT="${DEMO_REMOTE_ROOT}"
fi
PREVIEW_URL="https://${PREVIEW_HOSTNAME}"
REMOTE_WORKDIR="${REMOTE_ROOT}/${PREVIEW_SLUG}"
echo "Port resolved: ${PREVIEW_PORT}"

DEPLOY_SUPERADMIN_EMAIL="${PREVIEW_ADMIN_EMAIL:-${SMOKE_TEST_EMAIL:-}}"
DEPLOY_SUPERADMIN_PASSWORD="${PREVIEW_ADMIN_PASSWORD:-${SMOKE_TEST_PASSWORD:-}}"
DEPLOY_ADMIN_EMAIL=""
DEPLOY_ADMIN_PASSWORD=""
DEPLOY_EMPLOYEE_EMAIL=""
DEPLOY_EMPLOYEE_PASSWORD=""
DEPLOY_APP_IMAGE="${DEPLOY_APP_IMAGE:-${APP_IMAGE:-}}"
DEPLOY_ECR_REGISTRY="${DEPLOY_ECR_REGISTRY:-${ECR_REGISTRY:-}}"
DEPLOY_ECR_PASSWORD="${DEPLOY_ECR_PASSWORD:-${ECR_PASSWORD:-}}"
DEPLOY_AWS_REGION="${AWS_REGION:-eu-west-2}"
DEPLOY_SUPERADMIN_PASSWORD_SECRET_ID=""
DEPLOY_ADMIN_PASSWORD_SECRET_ID=""
DEPLOY_EMPLOYEE_PASSWORD_SECRET_ID=""
if [[ "${PREVIEW_SLUG}" == "manoj" ]]; then
  DEPLOY_SUPERADMIN_EMAIL="${MANOJ_SUPERADMIN_EMAIL:-superadmin@manoj.om.they.dev}"
  DEPLOY_ADMIN_EMAIL="${MANOJ_ADMIN_EMAIL:-admin@manoj.om.they.dev}"
  DEPLOY_EMPLOYEE_EMAIL="${MANOJ_EMPLOYEE_EMAIL:-employee@manoj.om.they.dev}"
  DEPLOY_SUPERADMIN_PASSWORD_SECRET_ID="${MANOJ_SUPERADMIN_PASSWORD_SECRET_ID:-}"
  DEPLOY_ADMIN_PASSWORD_SECRET_ID="${MANOJ_ADMIN_PASSWORD_SECRET_ID:-}"
  DEPLOY_EMPLOYEE_PASSWORD_SECRET_ID="${MANOJ_EMPLOYEE_PASSWORD_SECRET_ID:-}"
  for required_var in DEPLOY_SUPERADMIN_PASSWORD_SECRET_ID DEPLOY_ADMIN_PASSWORD_SECRET_ID DEPLOY_EMPLOYEE_PASSWORD_SECRET_ID; do
    if [[ -z "${!required_var}" ]]; then
      echo "Missing required Manoj secret identifier for ${required_var}" >&2
      exit 1
    fi
  done
fi

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
  printf 'remote_root=%q\n' "${REMOTE_ROOT}"
  printf 'baseline_env_file=%q\n' "${BASELINE_ENV_FILE_REMOTE}"
  printf 'aws_region=%q\n' "${DEPLOY_AWS_REGION}"
  printf 'deploy_superadmin_email=%q\n' "${DEPLOY_SUPERADMIN_EMAIL}"
  printf 'deploy_admin_email=%q\n' "${DEPLOY_ADMIN_EMAIL}"
  printf 'deploy_employee_email=%q\n' "${DEPLOY_EMPLOYEE_EMAIL}"
  printf 'deploy_superadmin_password_secret_id=%q\n' "${DEPLOY_SUPERADMIN_PASSWORD_SECRET_ID}"
  printf 'deploy_admin_password_secret_id=%q\n' "${DEPLOY_ADMIN_PASSWORD_SECRET_ID}"
  printf 'deploy_employee_password_secret_id=%q\n' "${DEPLOY_EMPLOYEE_PASSWORD_SECRET_ID}"
  printf 'deploy_app_image=%q\n' "${DEPLOY_APP_IMAGE}"
  printf 'deploy_ecr_registry=%q\n' "${DEPLOY_ECR_REGISTRY}"
  if [[ "${PREVIEW_SLUG}" != "manoj" ]]; then
    printf 'deploy_superadmin_password=%q\n' "${DEPLOY_SUPERADMIN_PASSWORD}"
    printf 'deploy_admin_password=%q\n' "${DEPLOY_ADMIN_PASSWORD}"
    printf 'deploy_employee_password=%q\n' "${DEPLOY_EMPLOYEE_PASSWORD}"
    printf 'deploy_ecr_password=%q\n' "${DEPLOY_ECR_PASSWORD}"
  fi
  cat <<'EOF'
command -v git >/dev/null 2>&1 || { echo "Missing git on preview host" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "Missing docker on preview host" >&2; exit 1; }

persistent_demo=false
if [[ "$branch" == "fork/EPC" || "$branch" == "fork/manoj" ]]; then
  persistent_demo=true
fi

if [[ "$branch" == "fork/manoj" ]]; then
  command -v aws >/dev/null 2>&1 || { echo "Missing AWS CLI on preview host" >&2; exit 1; }
  existing_manoj_app="$(docker ps -q \
    --filter "label=com.docker.compose.project=${preview_project}" \
    --filter 'label=com.docker.compose.service=app')"
  existing_manoj_postgres="$(docker ps -q \
    --filter "label=com.docker.compose.project=${preview_project}" \
    --filter 'label=com.docker.compose.service=postgres')"
  if [[ -z "$existing_manoj_app" || -z "$existing_manoj_postgres" ]]; then
    echo "Manoj lifecycle deployment requires the existing running app and PostgreSQL containers; secure first-time provisioning is a separate procedure." >&2
    exit 1
  fi

  secret_value() {
    aws secretsmanager get-secret-value \
      --region "$aws_region" \
      --secret-id "$1" \
      --query SecretString \
      --output text
  }
  deploy_superadmin_password="$(secret_value "$deploy_superadmin_password_secret_id")"
  deploy_admin_password="$(secret_value "$deploy_admin_password_secret_id")"
  deploy_employee_password="$(secret_value "$deploy_employee_password_secret_id")"
  for secret_name in deploy_superadmin_password deploy_admin_password deploy_employee_password; do
    secret_value_to_validate="${!secret_name}"
    if [[ ${#secret_value_to_validate} -lt 20 || \
          ! "$secret_value_to_validate" =~ ^[A-Za-z0-9._!@%+=:-]+$ || \
          ! "$secret_value_to_validate" =~ [a-z] || \
          ! "$secret_value_to_validate" =~ [A-Z] || \
          ! "$secret_value_to_validate" =~ [0-9] || \
          ! "$secret_value_to_validate" =~ [!@%+=:._-] ]]; then
      echo "Manoj password secret has an invalid format: ${secret_name}" >&2
      exit 1
    fi
  done
  unset secret_value_to_validate
fi

mkdir -p "$remote_root"
if [[ ! -d "$workdir/.git" ]]; then
  if [[ "$deploy_mode" == "config-restart" ]]; then
    echo "Config-only deploy requires an existing preview checkout at ${workdir}" >&2
    exit 1
  fi
  git clone --branch "$branch" --single-branch "$repo_url" "$workdir"
else
  if [[ "$deploy_mode" == "full" || "$branch" == "fork/manoj" ]]; then
    git -C "$workdir" remote set-url origin "$repo_url"
    git -C "$workdir" fetch origin "$branch" --prune
    git -C "$workdir" checkout -B "$branch" "origin/$branch"
    git -C "$workdir" reset --hard "origin/$branch"
    if [[ "$persistent_demo" == "true" ]]; then
      git -C "$workdir" clean -fdx -e .env
    else
      git -C "$workdir" clean -fdx
    fi
  fi
fi

if [[ "$branch" != "fork/manoj" ]]; then
  export OM_DEPLOY_SUPERADMIN_PASSWORD="${deploy_superadmin_password:-}"
  export OM_DEPLOY_ADMIN_PASSWORD="${deploy_admin_password:-}"
  export OM_DEPLOY_EMPLOYEE_PASSWORD="${deploy_employee_password:-}"
fi
render_runtime_env() {
python3 - <<'PY' "$baseline_env_file" "$workdir/.env" "$preview_env" "$preview_port" "$preview_hostname" "$deploy_superadmin_email" "$deploy_mode" "$preview_project" "$deploy_admin_email" "$deploy_employee_email" "$branch" "$deploy_app_image"
import os, secrets, sys
from pathlib import Path
(
    baseline,
    target,
    preview_env,
    preview_port,
    preview_host,
    deploy_superadmin_email,
    deploy_mode,
    preview_project,
    deploy_admin_email,
    deploy_employee_email,
    branch,
    deploy_app_image,
) = sys.argv[1:13]
is_epc = branch == 'fork/EPC' or preview_host == 'preview-epc.om.they.dev'
is_manoj = branch == 'fork/manoj' or preview_host == 'manoj.om.they.dev'
deploy_superadmin_password = os.environ.get('OM_DEPLOY_SUPERADMIN_PASSWORD', '')
deploy_admin_password = os.environ.get('OM_DEPLOY_ADMIN_PASSWORD', '')
deploy_employee_password = os.environ.get('OM_DEPLOY_EMPLOYEE_PASSWORD', '')
preserve_existing = is_epc or is_manoj or deploy_mode == 'config-restart'
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
    'APP_NAME': preview_project,
    'DEPLOY_ENV': preview_env,
    'APP_PORT': preview_port,
    'APP_URL': f'https://{preview_host}',
    'NEXT_PUBLIC_APP_URL': f'https://{preview_host}',
    'PLATFORM_PORTAL_BASE_URL': f'https://{preview_host}',
    'POSTGRES_PASSWORD': secrets.token_urlsafe(24),
    'JWT_SECRET': secrets.token_urlsafe(48),
    'AUTH_SECRET': secrets.token_urlsafe(48),
    'TENANT_DATA_ENCRYPTION_KEY': secrets.token_urlsafe(48),
    'MEILISEARCH_MASTER_KEY': secrets.token_urlsafe(32),
    'OM_ENABLE_EPC_DEMO': 'true' if is_epc else 'false',
})
if is_manoj:
    values.update({
        'SELF_SERVICE_ONBOARDING_ENABLED': 'false',
        'DEMO_MODE': 'false',
        'MERCATO_INIT_ARGS': '--no-examples',
        'OM_INIT_REDACT_CREDENTIAL_OUTPUT': 'true',
    })
platform_domains = [
    domain.strip()
    for domain in (values.get('PLATFORM_DOMAINS') or 'localhost,openmercato.com').split(',')
    if domain.strip()
]
if preview_host.lower() not in {domain.lower() for domain in platform_domains}:
    platform_domains.append(preview_host)
values['PLATFORM_DOMAINS'] = ','.join(platform_domains)
for key in [
    'POSTGRES_PASSWORD',
    'JWT_SECRET',
    'AUTH_SECRET',
    'TENANT_DATA_ENCRYPTION_KEY',
    'MEILISEARCH_MASTER_KEY',
    'OM_INIT_SUPERADMIN_EMAIL',
    'OM_INIT_SUPERADMIN_PASSWORD',
    'OM_INIT_ADMIN_EMAIL',
    'OM_INIT_ADMIN_PASSWORD',
    'OM_INIT_EMPLOYEE_EMAIL',
    'OM_INIT_EMPLOYEE_PASSWORD',
    'MERCATO_INIT_ARGS',
    'OM_INIT_REDACT_CREDENTIAL_OUTPUT',
    'APP_IMAGE',
    'EPC_LEAD_TENANT_ID',
    'EPC_LEAD_ORGANIZATION_ID',
    'EPC_LEAD_OWNER_USER_ID',
    'EPC_LEAD_PIPELINE_STAGE_ID',
    'EPC_LEAD_CAPTURE_ALLOWED_ORIGINS',
]:
    if preserve_existing and existing.get(key):
        values[key] = existing[key]
if is_epc:
    values.update({
        'SELF_SERVICE_ONBOARDING_ENABLED': 'false',
        'SYSTEM_EMAIL_PROVIDER': 'ses',
        'AWS_SES_REGION': values.get('AWS_SES_REGION') or values.get('AWS_REGION') or 'eu-west-2',
        'EMAIL_FROM': values.get('EMAIL_FROM') or 'no-reply@they.dev',
        'NOTIFICATIONS_EMAIL_FROM': values.get('NOTIFICATIONS_EMAIL_FROM') or values.get('EMAIL_FROM') or 'no-reply@they.dev',
        'EPC_LEAD_CAPTURE_ALLOWED_ORIGINS': values.get('EPC_LEAD_CAPTURE_ALLOWED_ORIGINS') or f'https://{preview_host}',
    })
if is_manoj:
    values.update({
        'SELF_SERVICE_ONBOARDING_ENABLED': 'false',
        'DEMO_MODE': 'false',
        'MERCATO_INIT_ARGS': '--no-examples',
        'OM_ENABLE_EPC_DEMO': 'false',
        'OM_INIT_REDACT_CREDENTIAL_OUTPUT': 'true',
    })
    for key in [
        'OM_INIT_SUPERADMIN_PASSWORD',
        'OM_INIT_ADMIN_PASSWORD',
        'OM_INIT_EMPLOYEE_PASSWORD',
        'EPC_LEAD_TENANT_ID',
        'EPC_LEAD_ORGANIZATION_ID',
        'EPC_LEAD_OWNER_USER_ID',
        'EPC_LEAD_PIPELINE_STAGE_ID',
        'EPC_LEAD_CAPTURE_ALLOWED_ORIGINS',
    ]:
        values.pop(key, None)
if deploy_superadmin_email:
    values['OM_INIT_SUPERADMIN_EMAIL'] = deploy_superadmin_email
    values['ADMIN_EMAIL'] = deploy_superadmin_email
if deploy_superadmin_password and not is_manoj:
    values['OM_INIT_SUPERADMIN_PASSWORD'] = deploy_superadmin_password
if deploy_admin_email:
    values['OM_INIT_ADMIN_EMAIL'] = deploy_admin_email
if deploy_admin_password and not is_manoj:
    values['OM_INIT_ADMIN_PASSWORD'] = deploy_admin_password
if deploy_employee_email:
    values['OM_INIT_EMPLOYEE_EMAIL'] = deploy_employee_email
if deploy_employee_password and not is_manoj:
    values['OM_INIT_EMPLOYEE_PASSWORD'] = deploy_employee_password
if deploy_app_image:
    values['APP_IMAGE'] = deploy_app_image
keys = [
    'APP_NAME','DEPLOY_ENV','APP_PORT','APP_URL','NEXT_PUBLIC_APP_URL',
    'APP_IMAGE','PLATFORM_PORTAL_BASE_URL','PLATFORM_DOMAINS','POSTGRES_USER','POSTGRES_PASSWORD','POSTGRES_DB',
    'JWT_SECRET','AUTH_SECRET','TENANT_DATA_ENCRYPTION_KEY','MEILISEARCH_MASTER_KEY',
    'SELF_SERVICE_ONBOARDING_ENABLED','DEMO_MODE','MERCATO_INIT_ARGS','OM_ENABLE_EPC_DEMO',
    'OM_INIT_REDACT_CREDENTIAL_OUTPUT',
    'ADMIN_EMAIL','OM_INIT_SUPERADMIN_EMAIL','OM_INIT_SUPERADMIN_PASSWORD',
    'OM_INIT_ADMIN_EMAIL','OM_INIT_ADMIN_PASSWORD','OM_INIT_EMPLOYEE_EMAIL','OM_INIT_EMPLOYEE_PASSWORD',
    'OPENAI_API_KEY','SYSTEM_EMAIL_PROVIDER','AWS_SES_REGION',
    'AWS_SES_CONFIGURATION_SET','RESEND_API_KEY','EMAIL_FROM','NOTIFICATIONS_EMAIL_FROM',
    'EPC_LEAD_TENANT_ID','EPC_LEAD_ORGANIZATION_ID','EPC_LEAD_OWNER_USER_ID',
    'EPC_LEAD_PIPELINE_STAGE_ID','EPC_LEAD_CAPTURE_ALLOWED_ORIGINS'
]
content = '\n'.join(f'{key}={values[key]}' for key in keys if key in values) + '\n'
if is_manoj:
    sys.stdout.write(content)
else:
    target_path.write_text(content)
PY
}
if [[ "$branch" == "fork/manoj" ]]; then
  render_runtime_env \
    | python3 "$workdir/infra/aws-upstream-baseline/write-private-file.py" "$workdir/.env" \
        --required-key APP_PORT \
        --required-key APP_IMAGE \
        --required-key POSTGRES_PASSWORD \
        --required-key JWT_SECRET \
        --required-key AUTH_SECRET \
        --required-key TENANT_DATA_ENCRYPTION_KEY \
        --required-key MEILISEARCH_MASTER_KEY
else
  render_runtime_env
fi
unset OM_DEPLOY_SUPERADMIN_PASSWORD OM_DEPLOY_ADMIN_PASSWORD OM_DEPLOY_EMPLOYEE_PASSWORD

cd "$workdir"
if [[ "$branch" == "fork/manoj" ]]; then
  dotenv_value() {
    python3 infra/aws-upstream-baseline/read-dotenv-value.py .env "$1"
  }
  export APP_PORT="$(dotenv_value APP_PORT)"
  export APP_IMAGE="$(dotenv_value APP_IMAGE 2>/dev/null || true)"
  export POSTGRES_PASSWORD="$(dotenv_value POSTGRES_PASSWORD)"
  export POSTGRES_USER="$(dotenv_value POSTGRES_USER 2>/dev/null || true)"
  export POSTGRES_DB="$(dotenv_value POSTGRES_DB 2>/dev/null || true)"
else
  set -a
  . ./.env
  set +a
fi

compose() {
  local compose_files=(-f docker-compose.fullapp.yml)
  if [[ "$branch" == "fork/manoj" ]]; then
    compose_files+=(-f infra/aws-upstream-baseline/docker-compose.manoj-lifecycle.yml)
  fi
  COMPOSE_BAKE=false COMPOSE_DOCKER_CLI_BUILD=0 DOCKER_BUILDKIT=0 docker compose --project-name "$preview_project" --env-file .env "${compose_files[@]}" "$@"
}

persistent_stack_exists=false
if [[ "$persistent_demo" == "true" ]] && [[ -n "$(compose ps -q postgres 2>/dev/null || true)" ]]; then
  persistent_stack_exists=true
fi

if [[ "$branch" == "fork/manoj" ]]; then
  existing_manoj_postgres="$(compose ps -q postgres 2>/dev/null || true)"
  existing_manoj_app="$(compose ps -q app 2>/dev/null || true)"
  if [[ -z "$existing_manoj_postgres" || -z "$existing_manoj_app" ]]; then
    echo "Manoj lifecycle deployment requires the existing stack after checkout preparation." >&2
    exit 1
  fi

  email_hash_candidates() {
    docker exec \
      -e "OM_ACCOUNT_EMAIL=$1" \
      "$existing_manoj_app" \
      corepack yarn node --input-type=module -e \
        'import { emailHashLookupValues } from "@open-mercato/core/modules/auth/lib/emailHash"; process.stdout.write(emailHashLookupValues(process.env.OM_ACCOUNT_EMAIL).join("\n"))'
  }
  resolve_existing_account() {
    local email="$1"
    local expected_role="$2"
    local matches
    matches="$({
      email_hash_candidates "$email" \
        | python3 infra/aws-upstream-baseline/render-postgres-email-hashes-exists-sql.py "$expected_role"
    } | docker exec -i "$existing_manoj_postgres" \
      psql -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-open-mercato}" -v ON_ERROR_STOP=1 -At -f -)"
    if [[ "$(printf '%s\n' "$matches" | awk 'NF { count++ } END { print count + 0 }')" != "1" ]]; then
      echo "Manoj lifecycle deployment requires exactly one existing ${expected_role} account: ${email}" >&2
      exit 1
    fi
    printf '%s' "$matches"
  }
  IFS=$'\t' read -r deploy_superadmin_user_id deploy_superadmin_tenant_id <<< "$(resolve_existing_account "$deploy_superadmin_email" superadmin)"
  IFS=$'\t' read -r deploy_admin_user_id deploy_admin_tenant_id <<< "$(resolve_existing_account "$deploy_admin_email" admin)"
  IFS=$'\t' read -r deploy_employee_user_id deploy_employee_tenant_id <<< "$(resolve_existing_account "$deploy_employee_email" employee)"
  if [[ -z "$deploy_superadmin_user_id" || -z "$deploy_superadmin_tenant_id" || \
        "$deploy_superadmin_tenant_id" != "$deploy_admin_tenant_id" || \
        "$deploy_superadmin_tenant_id" != "$deploy_employee_tenant_id" ]]; then
    echo "Manoj lifecycle deployment requires the three expected accounts in one existing tenant." >&2
    exit 1
  fi
fi

if [[ "$preview_hostname" == "preview-epc.om.they.dev" && ( -z "${EPC_LEAD_TENANT_ID:-}" || -z "${EPC_LEAD_ORGANIZATION_ID:-}" ) ]]; then
  postgres_container="$(compose ps -q postgres 2>/dev/null || true)"
  if [[ -z "$postgres_container" ]]; then
    echo "Unable to derive EPC lead capture scope: preview postgres container is not running." >&2
    exit 1
  fi
  scope_line="$(docker exec -e PGPASSWORD="${POSTGRES_PASSWORD:-}" "$postgres_container" psql -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-open-mercato}" -At -F $'\t' -c "select tenant_id::text, id::text from organizations where deleted_at is null and is_active = true order by created_at asc limit 1;" | head -n 1)"
  if [[ -z "$scope_line" ]]; then
    echo "Unable to derive EPC lead capture scope: no active organization found." >&2
    exit 1
  fi
  IFS=$'\t' read -r epc_lead_tenant_id epc_lead_organization_id <<< "$scope_line"
  python3 - <<'PY' "$workdir/.env" "$epc_lead_tenant_id" "$epc_lead_organization_id"
import sys
from pathlib import Path

path = Path(sys.argv[1])
updates = {
    'EPC_LEAD_TENANT_ID': sys.argv[2],
    'EPC_LEAD_ORGANIZATION_ID': sys.argv[3],
}
values = {}
order = []
for line in path.read_text().splitlines():
    if not line or line.startswith('#') or '=' not in line:
        continue
    key, value = line.split('=', 1)
    if key not in values:
        order.append(key)
    values[key] = value
for key, value in updates.items():
    if key not in values:
        order.append(key)
    values[key] = value
path.write_text('\n'.join(f'{key}={values[key]}' for key in order if key in values) + '\n')
PY
  set -a
  . ./.env
  set +a
  echo "Derived EPC lead capture scope from preview organization ${EPC_LEAD_ORGANIZATION_ID}."
fi

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

sync_persistent_postgres_password() {
  if [[ "$persistent_demo" != "true" || -z "${POSTGRES_PASSWORD:-}" ]]; then
    return 0
  fi
  existing_persistent_postgres="$(compose ps -q postgres 2>/dev/null || true)"
  if [[ -z "$existing_persistent_postgres" ]]; then
    return 0
  fi
  pg_password_sql="$(
    printf '%s' "$POSTGRES_PASSWORD" \
      | python3 infra/aws-upstream-baseline/render-postgres-password-sql.py "${POSTGRES_USER:-postgres}"
  )"
  for attempt in 1 2 3 4 5; do
    if printf '%s\n' "$pg_password_sql" \
      | docker exec -i "$existing_persistent_postgres" psql -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-postgres}" -v ON_ERROR_STOP=1 -f - >/dev/null; then
      break
    fi
    if [[ "$attempt" == "5" ]]; then
      return 1
    fi
    echo "Postgres password sync attempt ${attempt} failed; retrying"
    sleep "$((attempt * 2))"
  done
  unset pg_password_sql
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
  app_image="${APP_IMAGE:-open-mercato/app:$preview_env}"
  if ! timeout 30s docker image inspect "$app_image" >/dev/null 2>&1; then
    echo "Missing existing image ${app_image}; run a full deploy first." >&2
    exit 1
  fi
  if [[ "$branch" == "fork/manoj" ]]; then
    existing_manoj_app="$(compose ps -q app 2>/dev/null || true)"
    if [[ -z "$existing_manoj_app" ]]; then
      echo "Manoj config restart requires the existing app container." >&2
      exit 1
    fi
    capability_status=0
    capability_output="$(
      docker exec "$existing_manoj_app" \
        corepack yarn mercato auth set-password \
          --email capability-check.invalid \
          --user-id 00000000-0000-4000-8000-000000000001 \
          --tenant-id 00000000-0000-4000-8000-000000000002 \
          --password-env OM_MISSING_CAPABILITY_PASSWORD 2>&1
    )" || capability_status=$?
    if [[ "$capability_status" == "0" || \
          "$capability_output" != *"--user-id <userId> --tenant-id <tenantId>"* || \
          "$capability_output" != *"--password-env <environmentVariable>"* ]]; then
      echo "Manoj config restart requires an image with the secure scoped password-rotation CLI; run a full deploy first." >&2
      exit 1
    fi
    unset capability_output capability_status
  fi
  sync_persistent_postgres_password
  compose up -d --no-deps --no-build --force-recreate app
else
  if ! timeout 30s docker image inspect opencode-mvp:latest >/dev/null 2>&1; then
    docker build -t opencode-mvp:latest docker/opencode
  fi
  if [[ -n "${APP_IMAGE:-}" ]]; then
    if [[ -n "${deploy_ecr_registry:-}" ]]; then
      if [[ "$branch" == "fork/manoj" ]]; then
        aws ecr get-login-password --region "$aws_region" \
          | docker login --username AWS --password-stdin "${deploy_ecr_registry}" >/dev/null
      elif [[ -n "${deploy_ecr_password:-}" ]]; then
        printf '%s' "${deploy_ecr_password}" | docker login --username AWS --password-stdin "${deploy_ecr_registry}" >/dev/null
        unset deploy_ecr_password
      fi
      cleanup_ecr_login() {
        docker logout "${deploy_ecr_registry}" >/dev/null 2>&1 || true
      }
      trap cleanup_ecr_login EXIT
    fi
    echo "Pulling prebuilt app image while the current app container stays online: ${APP_IMAGE}"
    timeout 900 docker pull "${APP_IMAGE}"
    docker image inspect "${APP_IMAGE}" --format '{{.Id}} {{.RepoTags}} {{.Created}}'
  else
    build_log="/tmp/openmercato-preview-${preview_env}-build.log"
    rm -f "$build_log"
    echo "Building new app image while the current app container stays online."
    if ! DOCKER_BUILDKIT=1 BUILDKIT_PROGRESS=plain timeout 45m docker build --progress=plain \
      --build-arg CONTAINER_PORT="${CONTAINER_PORT:-3000}" \
      -t "open-mercato/app:$preview_env" \
      . >"$build_log" 2>&1; then
      tail -n 240 "$build_log" || true
      exit 1
    fi
    tail -n 80 "$build_log" || true
  fi
  if [[ "$persistent_demo" == "true" && "$persistent_stack_exists" == "true" ]]; then
    echo "Persistent demo keeps Docker volumes intact; recreating app only."
    sync_persistent_postgres_password
    compose up -d --no-deps --no-build --force-recreate app
  elif [[ "$persistent_demo" == "true" ]]; then
    echo "Starting persistent demo stack with fresh isolated volumes."
    compose up -d --no-build --remove-orphans
  else
    echo "Recreating non-EPC preview after successful image build."
    compose down --remove-orphans --volumes >/dev/null 2>&1 || true
    compose up -d --no-build --remove-orphans
  fi
fi
wait_for_local_login

if [[ "$branch" == "fork/manoj" ]]; then
  app_container="$(compose ps -q app)"
  if [[ -z "$app_container" ]]; then
    echo "Manoj app container was not created." >&2
    exit 1
  fi

  restart_policy="$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$app_container")"
  if [[ "$restart_policy" != "unless-stopped" ]]; then
    echo "Unexpected Manoj app restart policy: ${restart_policy}" >&2
    exit 1
  fi
  env_mode="$(stat -c '%a' .env)"
  if [[ "$env_mode" != "600" ]]; then
    echo "Unexpected Manoj .env mode: ${env_mode}" >&2
    exit 1
  fi
  nonempty_file_passwords="$(awk -F= '/^OM_INIT_(SUPERADMIN|ADMIN|EMPLOYEE)_PASSWORD=./ { count++ } END { print count + 0 }' .env)"
  nonempty_container_passwords="$(
    docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$app_container" \
      | awk -F= '/^OM_INIT_(SUPERADMIN|ADMIN|EMPLOYEE)_PASSWORD=/ && length($2) > 0 { count++ } END { print count + 0 }'
  )"
  if [[ "$nonempty_file_passwords" != "0" || "$nonempty_container_passwords" != "0" ]]; then
    echo "Manoj bootstrap passwords remain in persistent runtime configuration." >&2
    exit 1
  fi

  rotate_account_password() {
    local email="$1"
    local user_id="$2"
    local tenant_id="$3"
    local password="$4"
    printf '%s\n' "$password" \
      | docker exec -i \
          -e "OM_ROTATED_ACCOUNT_EMAIL=${email}" \
          -e "OM_ROTATED_ACCOUNT_USER_ID=${user_id}" \
          -e "OM_ROTATED_ACCOUNT_TENANT_ID=${tenant_id}" \
          "$app_container" sh -lc \
          'IFS= read -r OM_ROTATED_ACCOUNT_PASSWORD; export OM_ROTATED_ACCOUNT_PASSWORD; corepack yarn mercato auth set-password --email "$OM_ROTATED_ACCOUNT_EMAIL" --user-id "$OM_ROTATED_ACCOUNT_USER_ID" --tenant-id "$OM_ROTATED_ACCOUNT_TENANT_ID" --password-env OM_ROTATED_ACCOUNT_PASSWORD'
  }
  rotate_account_password "$deploy_superadmin_email" "$deploy_superadmin_user_id" "$deploy_superadmin_tenant_id" "$deploy_superadmin_password"
  rotate_account_password "$deploy_admin_email" "$deploy_admin_user_id" "$deploy_admin_tenant_id" "$deploy_admin_password"
  rotate_account_password "$deploy_employee_email" "$deploy_employee_user_id" "$deploy_employee_tenant_id" "$deploy_employee_password"

  smoke_script_path='/tmp/openmercato-manoj-authenticated-smoke.mjs'
  docker cp scripts/smoke-auth-dashboard.mjs "$app_container:$smoke_script_path"
  authenticated_smoke() {
    local email="$1"
    local password="$2"
    printf '%s\n' "$password" \
      | docker exec -i \
          -e "SMOKE_TEST_EMAIL=${email}" \
          -e BASE_URL=http://127.0.0.1:3000 \
          -e SMOKE_TEST_PATHS=/backend \
          "$app_container" sh -lc \
            'IFS= read -r SMOKE_TEST_PASSWORD; export SMOKE_TEST_PASSWORD; exec node /tmp/openmercato-manoj-authenticated-smoke.mjs --run-smoke'
  }
  authenticated_smoke "$deploy_superadmin_email" "$deploy_superadmin_password"
  authenticated_smoke "$deploy_admin_email" "$deploy_admin_password"
  authenticated_smoke "$deploy_employee_email" "$deploy_employee_password"
  docker exec "$app_container" rm -f "$smoke_script_path"

  unset deploy_superadmin_password deploy_admin_password deploy_employee_password POSTGRES_PASSWORD
  echo "Manoj lifecycle checks passed: existing stack and accounts, private .env, empty bootstrap password variables, restart unless-stopped, and three authenticated logins."
fi
post_deploy_cleanup
EOF
} > "${REMOTE_SCRIPT}"

COMMANDS_JSON="$(python3 - <<'PY' "${REMOTE_SCRIPT}"
import json, sys
path = sys.argv[1]
print(json.dumps({'commands': [open(path, 'r', encoding='utf-8').read()]}))
PY
)"
SSM_CLOUDWATCH_ARGS=()
if [[ "${PREVIEW_SLUG}" == "manoj" ]]; then
  MANOJ_SSM_LOG_GROUP="${MANOJ_SSM_LOG_GROUP:-/aws/ssm/openmercato-upstream-baseline-dokploy/manoj-demo-deploy}"
  aws logs create-log-group \
    --region "${AWS_REGION}" \
    --log-group-name "${MANOJ_SSM_LOG_GROUP}" 2>/dev/null || true
  aws logs put-retention-policy \
    --region "${AWS_REGION}" \
    --log-group-name "${MANOJ_SSM_LOG_GROUP}" \
    --retention-in-days 14 2>/dev/null || true
  SSM_CLOUDWATCH_ARGS=(--cloud-watch-output-config "CloudWatchOutputEnabled=true,CloudWatchLogGroupName=${MANOJ_SSM_LOG_GROUP}")
fi

MANOJ_TARGET_QUIESCED=false
restore_manoj_target() {
  local original_status=$?
  if [[ "$MANOJ_TARGET_QUIESCED" == "true" && -n "${TARGET_GROUP_ARN:-}" && "$TARGET_GROUP_ARN" != "None" ]]; then
    echo "Restoring Manoj ALB target after an interrupted deployment." >&2
    if aws elbv2 register-targets \
      --region "${AWS_REGION}" \
      --target-group-arn "${TARGET_GROUP_ARN}" \
      --targets "Id=${PREVIEW_INSTANCE_ID},Port=${PREVIEW_PORT}" >/dev/null; then
      wait_for_target_healthy "${TARGET_GROUP_ARN}" 60 || true
    fi
  fi
  return "$original_status"
}
trap restore_manoj_target EXIT

if [[ "${PREVIEW_SLUG}" == "manoj" ]]; then
  TARGET_GROUP_ARN="$(aws elbv2 describe-target-groups \
    --region "${AWS_REGION}" \
    --names "${TARGET_GROUP_NAME}" \
    --query 'TargetGroups[0].TargetGroupArn' \
    --output text 2>/dev/null || true)"
  if [[ -n "${TARGET_GROUP_ARN}" && "${TARGET_GROUP_ARN}" != "None" ]]; then
    MANOJ_TARGET_QUIESCED=true
    aws elbv2 deregister-targets \
      --region "${AWS_REGION}" \
      --target-group-arn "${TARGET_GROUP_ARN}" \
      --targets "Id=${PREVIEW_INSTANCE_ID},Port=${PREVIEW_PORT}" >/dev/null
    aws elbv2 wait target-deregistered \
      --region "${AWS_REGION}" \
      --target-group-arn "${TARGET_GROUP_ARN}" \
      --targets "Id=${PREVIEW_INSTANCE_ID},Port=${PREVIEW_PORT}"
    echo "Manoj ALB target is quiesced before app recreation and credential rotation."
  fi
fi

COMMAND_ID="$(aws ssm send-command \
  --region "${AWS_REGION}" \
  --instance-ids "${PREVIEW_INSTANCE_ID}" \
  --document-name AWS-RunShellScript \
  --parameters "${COMMANDS_JSON}" \
  "${SSM_CLOUDWATCH_ARGS[@]}" \
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

aws elbv2 modify-target-group \
  --region "${AWS_REGION}" \
  --target-group-arn "${TARGET_GROUP_ARN}" \
  --health-check-protocol HTTP \
  --health-check-port "${PREVIEW_PORT}" \
  --health-check-path /login \
  --health-check-interval-seconds 15 \
  --health-check-timeout-seconds 10 \
  --healthy-threshold-count 2 \
  --unhealthy-threshold-count 2 \
  --matcher HttpCode=200-399 >/dev/null

aws elbv2 register-targets --region "${AWS_REGION}" --target-group-arn "${TARGET_GROUP_ARN}" --targets "Id=${PREVIEW_INSTANCE_ID},Port=${PREVIEW_PORT}" >/dev/null
MANOJ_TARGET_QUIESCED=false
echo "Registered preview target on port ${PREVIEW_PORT}"

RULE_ARN="$(existing_rule_arn_for_host "${PREVIEW_HOSTNAME}")"
if [[ -z "${RULE_ARN}" ]]; then
  PRIORITY="$(choose_rule_priority "$([[ "${PREVIEW_SLUG}" == "manoj" ]] && printf '1005' || true)")"
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
