#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./preview-common.sh
source "${SCRIPT_DIR}/preview-common.sh"

BRANCH="${1:-${BRANCH:-${GITHUB_REF_NAME:-${GITHUB_EVENT_REF:-}}}}"
if [[ -z "${BRANCH}" ]]; then
  echo "Usage: $0 <contrib/branch-name|fork/EPC>" >&2
  exit 1
fi
if [[ "${BRANCH}" == refs/heads/* ]]; then
  BRANCH="${BRANCH#refs/heads/}"
fi
if [[ "${BRANCH}" != contrib/* && "${BRANCH}" != "fork/EPC" ]]; then
  echo "Preview cleanup is only supported for contrib/* branches and fork/EPC" >&2
  exit 1
fi
if [[ "${BRANCH}" == "fork/EPC" && "${EPC_ALLOW_DESTRUCTIVE_DESTROY:-}" != "1" ]]; then
  echo "Refusing to destroy fork/EPC preview because it contains persistent demo data." >&2
  echo "Set EPC_ALLOW_DESTRUCTIVE_DESTROY=1 only for an intentional destructive reset." >&2
  exit 1
fi

PREVIEW_SLUG="$(branch_to_preview_slug "${BRANCH}")"
PREVIEW_HOSTNAME="$(preview_hostname_for_slug "${PREVIEW_SLUG}")"
TARGET_GROUP_NAME="$(target_group_name_for_slug "${PREVIEW_SLUG}")"
PREVIEW_PROJECT="preview-${PREVIEW_SLUG}"
REMOTE_WORKDIR="${PREVIEW_REMOTE_ROOT}/${PREVIEW_SLUG}"

REMOTE_SCRIPT="$(mktemp)"
{
  echo '#!/usr/bin/env bash'
  echo 'set -euo pipefail'
  printf 'workdir=%q\n' "${REMOTE_WORKDIR}"
  printf 'preview_project=%q\n' "${PREVIEW_PROJECT}"
  cat <<'EOF'
if [[ -d "$workdir" ]]; then
  cd "$workdir"
  docker compose --project-name "$preview_project" --env-file .env -f docker-compose.fullapp.yml down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$workdir"
fi
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
wait_for_ssm_command "${COMMAND_ID}" "${PREVIEW_INSTANCE_ID}" >/dev/null || true
rm -f "${REMOTE_SCRIPT}"

RULE_ARN="$(existing_rule_arn_for_host "${PREVIEW_HOSTNAME}")"
if [[ -n "${RULE_ARN}" ]]; then
  aws elbv2 delete-rule --region "${AWS_REGION}" --rule-arn "${RULE_ARN}" >/dev/null
fi

TARGET_GROUP_ARN="$(aws elbv2 describe-target-groups --region "${AWS_REGION}" --names "${TARGET_GROUP_NAME}" --query 'TargetGroups[0].TargetGroupArn' --output text 2>/dev/null || true)"
if [[ -n "${TARGET_GROUP_ARN}" && "${TARGET_GROUP_ARN}" != "None" ]]; then
  aws elbv2 deregister-targets --region "${AWS_REGION}" --target-group-arn "${TARGET_GROUP_ARN}" --targets "Id=${PREVIEW_INSTANCE_ID}" >/dev/null 2>&1 || true
  aws elbv2 delete-target-group --region "${AWS_REGION}" --target-group-arn "${TARGET_GROUP_ARN}" >/dev/null
fi

echo "preview_branch=${BRANCH}"
echo "preview_slug=${PREVIEW_SLUG}"
echo "preview_hostname=${PREVIEW_HOSTNAME}"
echo "preview_deleted=true"
