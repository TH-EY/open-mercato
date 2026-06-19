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
require_cmd python3

export AWS_PAGER=""

AWS_REGION="${AWS_REGION:-eu-west-2}"
NAME_PREFIX="${NAME_PREFIX:-openmercato-crm-they-dev}"
SSM_STEP_NAME="${SSM_STEP_NAME:-CRM deploy step}"
SSM_TIMEOUT_SECONDS="${SSM_TIMEOUT_SECONDS:-900}"
SSM_POLL_INTERVAL_SECONDS="${SSM_POLL_INTERVAL_SECONDS:-10}"
SSM_CLOUDWATCH_LOG_GROUP="${SSM_CLOUDWATCH_LOG_GROUP:-/aws/ssm/${NAME_PREFIX}/deploy}"
INSTANCE_ID="${INSTANCE_ID:-}"

if [[ -z "${INSTANCE_ID}" ]]; then
  INSTANCE_ID="$(aws ec2 describe-instances \
    --region "${AWS_REGION}" \
    --filters "Name=tag:Name,Values=${NAME_PREFIX}" "Name=instance-state-name,Values=running" \
    --query 'Reservations[0].Instances[0].InstanceId' \
    --output text)"
fi

if [[ -z "${INSTANCE_ID}" || "${INSTANCE_ID}" == "None" ]]; then
  echo "No running EC2 instance found for ${NAME_PREFIX}." >&2
  exit 1
fi

if [[ "$#" -gt 0 ]]; then
  REMOTE_BODY="$*"
else
  REMOTE_BODY="$(cat)"
fi

if [[ -z "${REMOTE_BODY//[[:space:]]/}" ]]; then
  echo "No remote command provided." >&2
  exit 1
fi

REMOTE_SCRIPT="$(mktemp)"
{
  echo "bash <<'EOF_CRM_SSM_STEP'"
  echo "set -euo pipefail"
  echo "${REMOTE_BODY}"
  echo "EOF_CRM_SSM_STEP"
} > "${REMOTE_SCRIPT}"

COMMANDS_JSON="$(python3 - <<'PY' "${REMOTE_SCRIPT}"
import json
import sys
from pathlib import Path

print(json.dumps({"commands": [Path(sys.argv[1]).read_text(encoding="utf-8")]}))
PY
)"
rm -f "${REMOTE_SCRIPT}"

echo "::group::SSM ${SSM_STEP_NAME}"
echo "Instance: ${INSTANCE_ID}"
echo "CloudWatch log group: ${SSM_CLOUDWATCH_LOG_GROUP}"
step_started_seconds="${SECONDS}"

append_step_summary() {
  if [[ -z "${GITHUB_STEP_SUMMARY:-}" ]]; then
    return
  fi

  local elapsed_seconds=$((SECONDS - step_started_seconds))
  {
    echo "- SSM step **${SSM_STEP_NAME}** finished with \`${status:-Unknown}\` in \`${elapsed_seconds}s\`; command \`${COMMAND_ID:-not-created}\`; logs \`${SSM_CLOUDWATCH_LOG_GROUP}\`."
  } >> "${GITHUB_STEP_SUMMARY}"
}

COMMAND_ID="$(aws ssm send-command \
  --region "${AWS_REGION}" \
  --instance-ids "${INSTANCE_ID}" \
  --document-name AWS-RunShellScript \
  --comment "${SSM_STEP_NAME}" \
  --parameters "${COMMANDS_JSON}" \
  --cloud-watch-output-config "CloudWatchOutputEnabled=true,CloudWatchLogGroupName=${SSM_CLOUDWATCH_LOG_GROUP}" \
  --query 'Command.CommandId' \
  --output text)"

echo "Command: ${COMMAND_ID}"

deadline=$((SECONDS + SSM_TIMEOUT_SECONDS))
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

  echo "Status: ${status}"

  case "${status}" in
    Success | Cancelled | TimedOut | Failed | Cancelling)
      break
      ;;
  esac

  sleep "${SSM_POLL_INTERVAL_SECONDS}"
done

if [[ -z "${invocation_json}" ]]; then
  echo "Timed out waiting for SSM command ${COMMAND_ID}; no invocation details were available." >&2
  if [[ -s /tmp/openmercato-crm-ssm-get-command.err ]]; then
    cat /tmp/openmercato-crm-ssm-get-command.err >&2
  fi
  append_step_summary
  echo "::endgroup::"
  exit 1
fi

stdout="$(jq -r '.Stdout // ""' <<<"${invocation_json}")"
stderr="$(jq -r '.Stderr // ""' <<<"${invocation_json}")"

if [[ -n "${stdout}" ]]; then
  echo "--- stdout ---"
  printf '%s\n' "${stdout}"
fi

if [[ -n "${stderr}" ]]; then
  echo "--- stderr ---" >&2
  printf '%s\n' "${stderr}" >&2
fi

echo "::endgroup::"
append_step_summary

if [[ "${status}" != "Success" ]]; then
  echo "SSM command ${COMMAND_ID} finished with status ${status}." >&2
  exit 1
fi
