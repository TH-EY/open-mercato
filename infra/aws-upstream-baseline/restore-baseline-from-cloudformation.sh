#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./preview-common.sh
source "${SCRIPT_DIR}/preview-common.sh"

SOURCE_DATABASE_URL="${SOURCE_DATABASE_URL:-$(fetch_secret_string "${OLD_STACK_DATABASE_URL_SECRET_ID}")}"
SOURCE_ENCRYPTION_KEY="${SOURCE_ENCRYPTION_KEY:-$(fetch_secret_string "${OLD_STACK_ENCRYPTION_KEY_SECRET_ID}")}"
BASELINE_URL="${BASELINE_URL:-https://om.they.dev}"
SMOKE_EMAIL="${SMOKE_TEST_EMAIL:-}"
SMOKE_PASSWORD="${SMOKE_TEST_PASSWORD:-}"
SOURCE_DB_INSTANCE_IDENTIFIER="${SOURCE_DB_INSTANCE_IDENTIFIER:-openmercato-postgres}"
PREVIEW_INSTANCE_SECURITY_GROUP_ID="${PREVIEW_INSTANCE_SECURITY_GROUP_ID:-$(aws ec2 describe-instances --region "${AWS_REGION}" --instance-ids "${PREVIEW_INSTANCE_ID}" --query 'Reservations[0].Instances[0].SecurityGroups[0].GroupId' --output text)}"
SOURCE_DB_SECURITY_GROUP_ID="${SOURCE_DB_SECURITY_GROUP_ID:-$(aws rds describe-db-instances --region "${AWS_REGION}" --db-instance-identifier "${SOURCE_DB_INSTANCE_IDENTIFIER}" --query 'DBInstances[0].VpcSecurityGroups[0].VpcSecurityGroupId' --output text)}"
SOURCE_POSTGRES_CLIENT_IMAGE="${SOURCE_POSTGRES_CLIENT_IMAGE:-postgres:18}"
OPENED_SOURCE_DB_RULE=0

cleanup_source_db_ingress() {
  if [[ "${OPENED_SOURCE_DB_RULE}" == "1" ]]; then
    aws ec2 revoke-security-group-ingress       --region "${AWS_REGION}"       --group-id "${SOURCE_DB_SECURITY_GROUP_ID}"       --ip-permissions "IpProtocol=tcp,FromPort=5432,ToPort=5432,UserIdGroupPairs=[{GroupId=${PREVIEW_INSTANCE_SECURITY_GROUP_ID}}]" >/dev/null 2>&1 || true
  fi
}
trap cleanup_source_db_ingress EXIT

ingress_error_file="$(mktemp)"
if aws ec2 authorize-security-group-ingress   --region "${AWS_REGION}"   --group-id "${SOURCE_DB_SECURITY_GROUP_ID}"   --ip-permissions "IpProtocol=tcp,FromPort=5432,ToPort=5432,UserIdGroupPairs=[{GroupId=${PREVIEW_INSTANCE_SECURITY_GROUP_ID}}]" >/dev/null 2>"${ingress_error_file}"; then
  OPENED_SOURCE_DB_RULE=1
elif grep -q 'InvalidPermission.Duplicate' "${ingress_error_file}"; then
  rm -f "${ingress_error_file}"
else
  cat "${ingress_error_file}" >&2
  rm -f "${ingress_error_file}"
  exit 1
fi
rm -f "${ingress_error_file}"

REMOTE_SCRIPT="$(mktemp)"
{
  echo '#!/usr/bin/env bash'
  echo 'set -euo pipefail'
  printf 'baseline_remote_root=%q\n' "${BASELINE_REMOTE_ROOT}"
  printf 'baseline_env_file=%q\n' "${BASELINE_ENV_FILE_REMOTE}"
  printf 'baseline_compose_project=%q\n' "${BASELINE_COMPOSE_PROJECT}"
  printf 'baseline_postgres_container=%q\n' "${BASELINE_POSTGRES_CONTAINER}"
  printf 'baseline_seed_root=%q\n' "${BASELINE_SEED_ROOT_REMOTE}"
  printf 'baseline_seed_dump=%q\n' "${BASELINE_SEED_DUMP_REMOTE}"
  printf 'baseline_seed_metadata=%q\n' "${BASELINE_SEED_METADATA_REMOTE}"
  printf 'baseline_backup_root=%q\n' "${BASELINE_BACKUP_ROOT_REMOTE}"
  printf 'source_database_url=%q\n' "${SOURCE_DATABASE_URL}"
  printf 'source_encryption_key=%q\n' "${SOURCE_ENCRYPTION_KEY}"
  printf 'postgres_client_image=%q\n' "${SOURCE_POSTGRES_CLIENT_IMAGE}"
  cat <<'INNER'
command -v docker >/dev/null 2>&1 || { echo "Missing docker on baseline host" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "Missing python3 on baseline host" >&2; exit 1; }

if [[ ! -f "$baseline_env_file" ]]; then
  echo "Baseline env file not found: $baseline_env_file" >&2
  exit 1
fi
if [[ ! -d "$baseline_remote_root" ]]; then
  echo "Baseline remote root not found: $baseline_remote_root" >&2
  exit 1
fi

postgres_password="$(grep '^POSTGRES_PASSWORD=' "$baseline_env_file" | head -n1 | cut -d= -f2-)"
postgres_user="$(grep '^POSTGRES_USER=' "$baseline_env_file" | head -n1 | cut -d= -f2-)"
postgres_db="$(grep '^POSTGRES_DB=' "$baseline_env_file" | head -n1 | cut -d= -f2-)"
deploy_env="$(grep '^DEPLOY_ENV=' "$baseline_env_file" | head -n1 | cut -d= -f2-)"
compose_file="$baseline_remote_root/docker-compose.fullapp.yml"
compose_cmd=(docker compose --project-name "$baseline_compose_project" --env-file "$baseline_env_file" -f "$compose_file")

mkdir -p "$baseline_backup_root" "$baseline_seed_root"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
restore_root="$baseline_backup_root/restore-$timestamp"
mkdir -p "$restore_root"
backup_dump="$restore_root/pre-restore-baseline.dump"
source_dump="$restore_root/source-cloudformation.dump"
source_schema="$restore_root/source-schema.sql"
baseline_schema="$restore_root/baseline-schema.sql"
restore_metadata="$restore_root/restore-metadata.json"
backup_env="$restore_root/baseline.env.before"
cp "$baseline_env_file" "$backup_env"

source_host="$(python3 - <<'PY' "$source_database_url"
from urllib.parse import urlparse
import sys
parsed = urlparse(sys.argv[1])
print(parsed.hostname or '')
PY
)"

source_migrations="$(docker run --rm -e SOURCE_DATABASE_URL="$source_database_url" "$postgres_client_image" sh -lc 'psql "$SOURCE_DATABASE_URL" -Atqc "select name from mikro_orm_migrations order by executed_at desc nulls last, id desc limit 10" 2>/dev/null' || true)"
baseline_migrations="$(docker exec -e PGPASSWORD="$postgres_password" "$baseline_postgres_container" psql -U "$postgres_user" -d "$postgres_db" -Atqc "select name from mikro_orm_migrations order by executed_at desc nulls last, id desc limit 10" 2>/dev/null || true)"

docker exec -e PGPASSWORD="$postgres_password" "$baseline_postgres_container" pg_dump -U "$postgres_user" -d "$postgres_db" --schema-only --no-owner --no-acl -f /tmp/baseline-schema.sql
docker exec -e PGPASSWORD="$postgres_password" "$baseline_postgres_container" pg_dump -U "$postgres_user" -d "$postgres_db" --format=custom --no-owner --no-acl -f /tmp/pre-restore-baseline.dump
docker cp "${baseline_postgres_container}:/tmp/baseline-schema.sql" "$baseline_schema"
docker cp "${baseline_postgres_container}:/tmp/pre-restore-baseline.dump" "$backup_dump"
docker exec "$baseline_postgres_container" rm -f /tmp/baseline-schema.sql /tmp/pre-restore-baseline.dump >/dev/null 2>&1 || true

docker run --rm -e SOURCE_DATABASE_URL="$source_database_url" -v "$restore_root:/backup" "$postgres_client_image" sh -lc '
  pg_dump "$SOURCE_DATABASE_URL" --schema-only --no-owner --no-acl -f /backup/source-schema.sql
  pg_dump "$SOURCE_DATABASE_URL" --format=custom --no-owner --no-acl -f /backup/source-cloudformation.dump
'

python3 - <<'PY' "$baseline_env_file" "$source_encryption_key"
from pathlib import Path
import sys
path = Path(sys.argv[1])
value = sys.argv[2]
lines = path.read_text(encoding='utf-8').splitlines()
out = []
replaced = False
for line in lines:
    if line.startswith('TENANT_DATA_ENCRYPTION_KEY='):
        out.append(f'TENANT_DATA_ENCRYPTION_KEY={value}')
        replaced = True
    elif line.startswith('TENANT_DATA_ENCRYPTION_FALLBACK_KEY='):
        out.append(f'TENANT_DATA_ENCRYPTION_FALLBACK_KEY={value}')
    else:
        out.append(line)
if not replaced:
    out.append(f'TENANT_DATA_ENCRYPTION_KEY={value}')
out.append(f'TENANT_DATA_ENCRYPTION_FALLBACK_KEY={value}') if not any(line.startswith('TENANT_DATA_ENCRYPTION_FALLBACK_KEY=') for line in lines) else None
path.write_text('\n'.join(out) + '\n', encoding='utf-8')
PY

"${compose_cmd[@]}" stop app opencode >/dev/null 2>&1 || true

docker exec -e PGPASSWORD="$postgres_password" "$baseline_postgres_container" psql -U "$postgres_user" -d postgres -v ON_ERROR_STOP=1 -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$postgres_db' AND pid <> pg_backend_pid();" -c "DROP DATABASE IF EXISTS \"$postgres_db\";" -c "CREATE DATABASE \"$postgres_db\";"

docker cp "$source_dump" "${baseline_postgres_container}:/tmp/source-cloudformation.dump"
docker exec -e PGPASSWORD="$postgres_password" "$baseline_postgres_container" pg_restore -U "$postgres_user" -d "$postgres_db" --no-owner --no-acl /tmp/source-cloudformation.dump
docker exec "$baseline_postgres_container" rm -f /tmp/source-cloudformation.dump >/dev/null 2>&1 || true

"${compose_cmd[@]}" up -d --build

python3 - <<'PY' "$restore_metadata" "$deploy_env" "$source_host" "$backup_dump" "$source_dump" "$baseline_schema" "$source_schema" "$backup_env" "$source_migrations" "$baseline_migrations"
import hashlib
import json
import sys
from datetime import datetime, timezone

metadata_path, deploy_env, source_host, backup_dump, source_dump, baseline_schema, source_schema, backup_env, source_migrations, baseline_migrations = sys.argv[1:11]

def sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, 'rb') as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()

metadata = {
    'restoredAt': datetime.now(timezone.utc).isoformat(),
    'deployEnv': deploy_env,
    'sourceHost': source_host,
    'backupDumpPath': backup_dump,
    'backupDumpSha256': sha256(backup_dump),
    'sourceDumpPath': source_dump,
    'sourceDumpSha256': sha256(source_dump),
    'baselineSchemaPath': baseline_schema,
    'sourceSchemaPath': source_schema,
    'baselineEnvBackupPath': backup_env,
    'sourceLatestMigrations': [line for line in source_migrations.splitlines() if line.strip()],
    'baselineLatestMigrationsBeforeRestore': [line for line in baseline_migrations.splitlines() if line.strip()],
}
with open(metadata_path, 'w', encoding='utf-8') as fh:
    json.dump(metadata, fh, indent=2)
print(json.dumps(metadata))
PY
INNER
} > "${REMOTE_SCRIPT}"

COMMAND_ID="$(aws ssm send-command \
  --region "${AWS_REGION}" \
  --instance-ids "${PREVIEW_INSTANCE_ID}" \
  --document-name AWS-RunShellScript \
  --parameters "$(json_escape_file "${REMOTE_SCRIPT}")" \
  --query 'Command.CommandId' \
  --output text)"
rm -f "${REMOTE_SCRIPT}"

wait_for_ssm_command "${COMMAND_ID}" "${PREVIEW_INSTANCE_ID}"
wait_for_http_200 "${BASELINE_URL}/login" 120
"${SCRIPT_DIR}/export-baseline-seed-dump.sh" >/dev/null

if [[ -n "${SMOKE_EMAIL}" && -n "${SMOKE_PASSWORD}" ]]; then
  SMOKE_TEST_EMAIL="${SMOKE_EMAIL}" \
  SMOKE_TEST_PASSWORD="${SMOKE_PASSWORD}" \
  BASE_URL="${BASELINE_URL}" \
  "${SCRIPT_DIR}/smoke.sh"
else
  echo "Skipped authenticated smoke because SMOKE_TEST_EMAIL and SMOKE_TEST_PASSWORD were not both provided." >&2
fi

echo "baseline_url=${BASELINE_URL}"
echo "baseline_seed_dump=${BASELINE_SEED_DUMP_REMOTE}"
echo "baseline_seed_metadata=${BASELINE_SEED_METADATA_REMOTE}"
