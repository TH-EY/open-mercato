#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./preview-common.sh
source "${SCRIPT_DIR}/preview-common.sh"

REMOTE_SCRIPT="$(mktemp)"
{
  echo '#!/usr/bin/env bash'
  echo 'set -euo pipefail'
  printf 'baseline_env_file=%q\n' "${BASELINE_ENV_FILE_REMOTE}"
  printf 'baseline_seed_root=%q\n' "${BASELINE_SEED_ROOT_REMOTE}"
  printf 'baseline_seed_dump=%q\n' "${BASELINE_SEED_DUMP_REMOTE}"
  printf 'baseline_seed_metadata=%q\n' "${BASELINE_SEED_METADATA_REMOTE}"
  printf 'baseline_postgres_container=%q\n' "${BASELINE_POSTGRES_CONTAINER}"
  cat <<'INNER'
postgres_password="$(grep '^POSTGRES_PASSWORD=' "$baseline_env_file" | head -n1 | cut -d= -f2-)"
postgres_user="$(grep '^POSTGRES_USER=' "$baseline_env_file" | head -n1 | cut -d= -f2-)"
postgres_db="$(grep '^POSTGRES_DB=' "$baseline_env_file" | head -n1 | cut -d= -f2-)"
deploy_env="$(grep '^DEPLOY_ENV=' "$baseline_env_file" | head -n1 | cut -d= -f2-)"

mkdir -p "$baseline_seed_root"
tmp_dump="$(mktemp "${baseline_seed_root}/baseline-seed.XXXXXX.dump")"

docker exec -e PGPASSWORD="$postgres_password" "$baseline_postgres_container" pg_dump -U "$postgres_user" -d "$postgres_db" --format=custom --no-owner --no-acl -f /tmp/baseline-seed.dump
docker cp "${baseline_postgres_container}:/tmp/baseline-seed.dump" "$tmp_dump"
docker exec "$baseline_postgres_container" rm -f /tmp/baseline-seed.dump >/dev/null 2>&1 || true
mv "$tmp_dump" "$baseline_seed_dump"
python3 - <<'PY' "$baseline_seed_dump" "$baseline_seed_metadata" "$deploy_env"
import hashlib, json, os, sys
from datetime import datetime, timezone

dump_path, metadata_path, deploy_env = sys.argv[1:4]
sha256 = hashlib.sha256()
with open(dump_path, 'rb') as fh:
    for chunk in iter(lambda: fh.read(1024 * 1024), b''):
        sha256.update(chunk)
metadata = {
    'source': 'om.they.dev',
    'deployEnv': deploy_env,
    'dumpPath': dump_path,
    'sha256': sha256.hexdigest(),
    'sizeBytes': os.path.getsize(dump_path),
    'exportedAt': datetime.now(timezone.utc).isoformat(),
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
