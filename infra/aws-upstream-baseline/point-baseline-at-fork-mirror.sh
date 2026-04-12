#!/usr/bin/env bash
set -euo pipefail

AWS_REGION="${AWS_REGION:-eu-west-2}"
PREVIEW_INSTANCE_ID="${PREVIEW_INSTANCE_ID:-i-0c6ec8e5a53900297}"
COMPOSE_ID="${COMPOSE_ID:-1KciWOsJvTtd2dM0Ltgmh}"
CUSTOM_GIT_URL="${CUSTOM_GIT_URL:-https://github.com/TH-EY/open-mercato.git}"
CUSTOM_GIT_BRANCH="${CUSTOM_GIT_BRANCH:-upstream-baseline}"
COMPOSE_PATH="${COMPOSE_PATH:-docker-compose.fullapp.yml}"

REMOTE_SCRIPT="$(mktemp)"
{
  echo '#!/usr/bin/env bash'
  echo 'set -euo pipefail'
  cat <<EOF
cat > /tmp/point-baseline.sql <<'SQL'
update compose
set "customGitUrl" = '${CUSTOM_GIT_URL}',
    "customGitBranch" = '${CUSTOM_GIT_BRANCH}',
    "composePath" = '${COMPOSE_PATH}'
where "composeId" = '${COMPOSE_ID}';

select "composeId", "customGitUrl", "customGitBranch", "composePath"
from compose
where "composeId" = '${COMPOSE_ID}';
SQL
EOF
  cat <<'EOF'
docker cp /tmp/point-baseline.sql dokploy-postgres.1.uvtt7vu0026cotn3h2gvrmnna:/tmp/point-baseline.sql
docker exec dokploy-postgres.1.uvtt7vu0026cotn3h2gvrmnna sh -lc 'PGPASSWORD="$(cat /run/secrets/postgres_password)" psql -U dokploy -d dokploy -f /tmp/point-baseline.sql'
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
rm -f "${REMOTE_SCRIPT}"

while true; do
  STATUS="$(aws ssm get-command-invocation --region "${AWS_REGION}" --command-id "${COMMAND_ID}" --instance-id "${PREVIEW_INSTANCE_ID}" --query 'Status' --output text)"
  case "${STATUS}" in
    Pending|InProgress|Delayed) sleep 5 ;;
    Success)
      aws ssm get-command-invocation --region "${AWS_REGION}" --command-id "${COMMAND_ID}" --instance-id "${PREVIEW_INSTANCE_ID}" --query 'StandardOutputContent' --output text
      break
      ;;
    *)
      aws ssm get-command-invocation --region "${AWS_REGION}" --command-id "${COMMAND_ID}" --instance-id "${PREVIEW_INSTANCE_ID}" --output json >&2 || true
      exit 1
      ;;
  esac
done
