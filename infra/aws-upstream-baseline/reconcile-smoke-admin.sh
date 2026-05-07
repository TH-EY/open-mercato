#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF' >&2
Usage:
  reconcile-smoke-admin.sh \
    --workdir <repo-dir> \
    --project-name <docker-compose-project> \
    --env-file <path-to-.env> \
    --compose-file <path-to-docker-compose.fullapp.yml> \
    --email <smoke-admin-email> \
    --password <smoke-admin-password> \
    --tenant-id <tenant-id> \
    [--role <role-name>]

Notes:
  - Requires an already running Compose stack with app + postgres services.
  - Idempotent: safe to rerun after DB restore / preview refresh.
  - Intended to reconcile seeded/restored data with smoke admin expectations.
EOF
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

require_cmd docker
require_cmd python3

WORKDIR=""
PROJECT_NAME=""
ENV_FILE=""
COMPOSE_FILE=""
ADMIN_EMAIL=""
ADMIN_PASSWORD=""
TENANT_ID=""
ROLE_NAME="superadmin"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --workdir)
      WORKDIR="${2:-}"
      shift 2
      ;;
    --project-name)
      PROJECT_NAME="${2:-}"
      shift 2
      ;;
    --env-file)
      ENV_FILE="${2:-}"
      shift 2
      ;;
    --compose-file)
      COMPOSE_FILE="${2:-}"
      shift 2
      ;;
    --email)
      ADMIN_EMAIL="${2:-}"
      shift 2
      ;;
    --password)
      ADMIN_PASSWORD="${2:-}"
      shift 2
      ;;
    --tenant-id)
      TENANT_ID="${2:-}"
      shift 2
      ;;
    --role)
      ROLE_NAME="${2:-}"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      ;;
  esac
done

if [[ -z "$WORKDIR" || -z "$PROJECT_NAME" || -z "$ENV_FILE" || -z "$COMPOSE_FILE" || -z "$ADMIN_EMAIL" || -z "$ADMIN_PASSWORD" || -z "$TENANT_ID" ]]; then
  usage
fi

if [[ ! -d "$WORKDIR" ]]; then
  echo "Workdir does not exist: $WORKDIR" >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Env file does not exist: $ENV_FILE" >&2
  exit 1
fi

if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "Compose file does not exist: $COMPOSE_FILE" >&2
  exit 1
fi

set -a
source "$ENV_FILE"
set +a

POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_DB="${POSTGRES_DB:-open-mercato}"

compose() {
  (
    cd "$WORKDIR"
    docker compose \
      --project-name "$PROJECT_NAME" \
      --env-file "$ENV_FILE" \
      -f "$COMPOSE_FILE" \
      "$@"
  )
}

psql_query() {
  local sql="$1"
  compose exec -T postgres sh -lc \
    "psql -U '$POSTGRES_USER' -d '$POSTGRES_DB' -Atqc $(printf '%q' "$sql")"
}

run_app_cli() {
  compose run --rm --no-deps app yarn mercato "$@"
}

EMAIL_HASH="$(python3 - <<'PY' "$ADMIN_EMAIL"
import hashlib, sys
print(hashlib.sha256(sys.argv[1].strip().lower().encode()).hexdigest())
PY
)"

ORG_ROW="$(psql_query "select id || E'\t' || name from organizations where tenant_id='${TENANT_ID}' and deleted_at is null order by created_at asc limit 1;")"

if [[ -z "$ORG_ROW" ]]; then
  echo "[reconcile-smoke-admin] No organization found for tenant ${TENANT_ID}" >&2
  exit 1
fi

ORG_ID="${ORG_ROW%%$'\t'*}"
ORG_NAME="${ORG_ROW#*$'\t'}"

echo "[reconcile-smoke-admin] Target tenant: ${TENANT_ID}"
echo "[reconcile-smoke-admin] Target organization: ${ORG_ID} (${ORG_NAME})"
echo "[reconcile-smoke-admin] Target smoke admin: ${ADMIN_EMAIL}"

run_app_cli auth seed-roles --tenant "$TENANT_ID"

USER_EXISTS="$(psql_query "select 1 from users where tenant_id='${TENANT_ID}' and email_hash='${EMAIL_HASH}' and deleted_at is null limit 1;")"

if [[ -z "$USER_EXISTS" ]]; then
  echo "[reconcile-smoke-admin] Smoke admin missing in restored data, creating user..."
  run_app_cli auth add-user \
    --email "$ADMIN_EMAIL" \
    --password "$ADMIN_PASSWORD" \
    --organizationId "$ORG_ID" \
    --roles "$ROLE_NAME"
else
  echo "[reconcile-smoke-admin] Smoke admin already exists; skipping add-user."
fi

run_app_cli auth setup \
  --orgName "$ORG_NAME" \
  --email "$ADMIN_EMAIL" \
  --password "$ADMIN_PASSWORD" \
  --roles "$ROLE_NAME" \
  --skip-password-policy

run_app_cli auth list-users --tenantId "$TENANT_ID"

echo "[reconcile-smoke-admin] Reconciliation complete."
