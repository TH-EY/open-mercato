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
SSM_STEP_NAME="${SSM_STEP_NAME:-Public demo deploy step}"
SSM_TIMEOUT_SECONDS="${SSM_TIMEOUT_SECONDS:-900}"
SSM_POLL_INTERVAL_SECONDS="${SSM_POLL_INTERVAL_SECONDS:-10}"
INSTANCE_ID="${INSTANCE_ID:-}"

if [[ -z "${INSTANCE_ID}" ]]; then
  echo "INSTANCE_ID is required; target discovery is intentionally disabled." >&2
  exit 1
fi

if [[ "$#" -gt 0 ]]; then
  remote_body="$*"
else
  remote_body="$(cat)"
fi

if [[ -z "${remote_body//[[:space:]]/}" ]]; then
  echo "No remote command provided." >&2
  exit 1
fi

remote_script="$(mktemp)"
parameters_file="$(mktemp)"
invocation_error_file="$(mktemp)"
command_id=""
command_active=0
status="Pending"

cleanup() {
  rm -f "${remote_script}" "${parameters_file}" "${invocation_error_file}"
}

cancel_active_command() {
  if [[ "${command_active}" -eq 1 && -n "${command_id}" ]]; then
    if ! aws ssm cancel-command \
      --region "${AWS_REGION}" \
      --command-id "${command_id}" \
      --instance-ids "${INSTANCE_ID}" >/dev/null; then
      echo "Failed to request cancellation for SSM command ${command_id}." >&2
      return 1
    fi
    for cancellation_attempt in 1 2 3 4 5 6; do
      cancellation_status="$(aws ssm get-command-invocation \
        --region "${AWS_REGION}" \
        --command-id "${command_id}" \
        --instance-id "${INSTANCE_ID}" \
        --query Status \
        --output text 2>/dev/null || true)"
      case "${cancellation_status}" in
        Success | Cancelled | TimedOut | Failed)
          command_active=0
          echo "SSM command ${command_id} reached terminal status ${cancellation_status}."
          return 0
          ;;
      esac
      sleep 5
    done
    echo "SSM command ${command_id} did not reach a terminal status after cancellation." >&2
    return 1
  fi
}

handle_signal() {
  status="Cancelled"
  cancel_active_command || status="CancellationUnconfirmed"
  exit 130
}

trap cleanup EXIT
trap handle_signal HUP INT TERM

{
  echo "bash <<'EOF_PUBLIC_DEMO_SSM_STEP'"
  echo "set -euo pipefail"
  echo "${remote_body}"
  echo "EOF_PUBLIC_DEMO_SSM_STEP"
} > "${remote_script}"

python3 - "${remote_script}" "${parameters_file}" "${SSM_TIMEOUT_SECONDS}" <<'PY'
import json
import sys
from pathlib import Path

source_path = Path(sys.argv[1])
target_path = Path(sys.argv[2])
target_path.write_text(
    json.dumps({
        "commands": [source_path.read_text(encoding="utf-8")],
        "executionTimeout": [sys.argv[3]],
    }),
    encoding="utf-8",
)
PY

echo "::group::SSM ${SSM_STEP_NAME}"
echo "Instance: ${INSTANCE_ID}"
step_started_seconds="${SECONDS}"

append_step_summary() {
  if [[ -z "${GITHUB_STEP_SUMMARY:-}" ]]; then
    return
  fi

  local elapsed_seconds=$((SECONDS - step_started_seconds))
  {
    echo "- SSM step **${SSM_STEP_NAME}** finished with \`${status}\` in \`${elapsed_seconds}s\`; command \`${command_id:-not-created}\`."
  } >> "${GITHUB_STEP_SUMMARY}"
}

command_id="$(aws ssm send-command \
  --region "${AWS_REGION}" \
  --instance-ids "${INSTANCE_ID}" \
  --document-name AWS-RunShellScript \
  --comment "${SSM_STEP_NAME}" \
  --parameters "file://${parameters_file}" \
  --query 'Command.CommandId' \
  --output text)"
command_active=1

echo "Command: ${command_id}"

deadline=$((SECONDS + SSM_TIMEOUT_SECONDS))
invocation_json=""

while ((SECONDS < deadline)); do
  if invocation_json="$(aws ssm get-command-invocation \
    --region "${AWS_REGION}" \
    --command-id "${command_id}" \
    --instance-id "${INSTANCE_ID}" \
    --query '{Status:Status,ResponseCode:ResponseCode,Stdout:StandardOutputContent,Stderr:StandardErrorContent}' \
    --output json 2>"${invocation_error_file}")"; then
    status="$(jq -r '.Status' <<<"${invocation_json}")"
  else
    status="Pending"
  fi

  echo "Status: ${status}"

  case "${status}" in
    Success | Cancelled | TimedOut | Failed)
      command_active=0
      break
      ;;
  esac

  sleep "${SSM_POLL_INTERVAL_SECONDS}"
done

if [[ -z "${invocation_json}" || "${status}" == "Pending" || "${status}" == "InProgress" ]]; then
  status="TimedOut"
  cancellation_confirmed=1
  cancel_active_command || cancellation_confirmed=0
  echo "Timed out waiting for SSM command ${command_id}; cancellation requested." >&2
  if [[ "${cancellation_confirmed}" -ne 1 ]]; then
    echo "Remote cancellation could not be confirmed; executionTimeout remains the final bound." >&2
  fi
  if [[ -s "${invocation_error_file}" ]]; then
    cat "${invocation_error_file}" >&2
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
  echo "SSM command ${command_id} finished with status ${status}." >&2
  exit 1
fi
