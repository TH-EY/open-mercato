#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./preview-common.sh
source "${SCRIPT_DIR}/preview-common.sh"

DEMO_NAME="${1:-${DEMO_NAME:-}}"
DELETE_DATA="false"
if [[ -z "${DEMO_NAME}" ]]; then
  echo "Usage: $0 <demo-name> [--delete-data]" >&2
  exit 1
fi
shift || true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --delete-data)
      DELETE_DATA="true"
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

DEMO_SLUG="$(python3 - <<'PY' "${DEMO_NAME}"
import re, sys
base = sys.argv[1].lower()
base = re.sub(r'[^a-z0-9]+', '-', base).strip('-')
if not base:
    raise SystemExit('Demo name must contain at least one letter or digit')
print(base[:50].strip('-'))
PY
)"
DEMO_HOSTNAME="${DEMO_HOSTNAME:-${DEMO_SLUG}.${PREVIEW_HOST_SUFFIX}}"
DEMO_PROJECT="demo-${DEMO_SLUG}"
DEMO_REMOTE_ROOT="${DEMO_REMOTE_ROOT:-/opt/openmercato-demos}"
DEMO_WORKDIR="${DEMO_REMOTE_ROOT}/${DEMO_SLUG}"
TARGET_GROUP_NAME="$(python3 - <<'PY' "${DEMO_SLUG}"
import hashlib, sys
print(f"om-demo-{hashlib.sha1(sys.argv[1].encode()).hexdigest()[:9]}")
PY
)"

REMOTE_SCRIPT="$(mktemp)"
{
  echo "bash <<'EOF_DEMO_DESTROY_BASH'"
  echo 'set -euo pipefail'
  printf 'workdir=%q\n' "${DEMO_WORKDIR}"
  printf 'demo_project=%q\n' "${DEMO_PROJECT}"
  printf 'delete_data=%q\n' "${DELETE_DATA}"
  cat <<'EOF_REMOTE'
if [[ -d "$workdir" ]]; then
  cd "$workdir"
  if [[ "$delete_data" == "true" ]]; then
    docker compose --project-name "$demo_project" --env-file .env -f docker-compose.fullapp.yml down --volumes --remove-orphans >/dev/null 2>&1 || true
    rm -rf "$workdir"
  else
    docker compose --project-name "$demo_project" --env-file .env -f docker-compose.fullapp.yml down --remove-orphans >/dev/null 2>&1 || true
    echo "Demo containers stopped; data volumes and workdir were preserved."
  fi
fi
EOF_REMOTE
  echo 'EOF_DEMO_DESTROY_BASH'
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
wait_for_ssm_command "${COMMAND_ID}" "${PREVIEW_INSTANCE_ID}" >/dev/null || true
rm -f "${REMOTE_SCRIPT}"

RULE_ARN="$(existing_rule_arn_for_host "${DEMO_HOSTNAME}")"
if [[ -n "${RULE_ARN}" ]]; then
  aws elbv2 delete-rule --region "${AWS_REGION}" --rule-arn "${RULE_ARN}" >/dev/null
fi

TARGET_GROUP_ARN="$(aws elbv2 describe-target-groups --region "${AWS_REGION}" --names "${TARGET_GROUP_NAME}" --query 'TargetGroups[0].TargetGroupArn' --output text 2>/dev/null || true)"
if [[ -n "${TARGET_GROUP_ARN}" && "${TARGET_GROUP_ARN}" != "None" ]]; then
  aws elbv2 deregister-targets --region "${AWS_REGION}" --target-group-arn "${TARGET_GROUP_ARN}" --targets "Id=${PREVIEW_INSTANCE_ID}" >/dev/null 2>&1 || true
  aws elbv2 delete-target-group --region "${AWS_REGION}" --target-group-arn "${TARGET_GROUP_ARN}" >/dev/null
fi

echo "demo_name=${DEMO_SLUG}"
echo "demo_hostname=${DEMO_HOSTNAME}"
echo "demo_deleted=true"
echo "demo_data_deleted=${DELETE_DATA}"
