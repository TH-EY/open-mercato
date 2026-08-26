#!/usr/bin/env bash
set -euo pipefail

umask 077
export AWS_PAGER=""

for command_name in aws python3; do
  command -v "${command_name}" >/dev/null 2>&1 || {
    echo "${command_name} is required." >&2
    exit 1
  }
done

for required_name in AWS_REGION AWS_ACCOUNT_ID WORKLOAD_ROLE_NAME SES_IDENTITY_ARN; do
  [[ -n "${!required_name:-}" ]] || {
    echo "${required_name} is required." >&2
    exit 1
  }
done

[[ "${AWS_ACCOUNT_ID}" =~ ^[0-9]{12}$ ]] || {
  echo "AWS_ACCOUNT_ID must be 12 digits." >&2
  exit 1
}
expected_identity_arn="arn:aws:ses:${AWS_REGION}:${AWS_ACCOUNT_ID}:identity/they.dev"
[[ "${SES_IDENTITY_ARN}" == "${expected_identity_arn}" ]] || {
  echo "SES_IDENTITY_ARN must be the exact they.dev identity in the required account and region." >&2
  exit 1
}
caller_account="$(aws sts get-caller-identity --query Account --output text)"
[[ "${caller_account}" == "${AWS_ACCOUNT_ID}" ]] || {
  echo "AWS caller account does not match AWS_ACCOUNT_ID." >&2
  exit 1
}

policy_name="OpenMercatoPublicDemoSesSend"
temporary_directory="$(mktemp -d)"
predecessor_file="${temporary_directory}/predecessor.json"
expected_file="${temporary_directory}/expected.json"
current_file="${temporary_directory}/current.json"
readback_file="${temporary_directory}/readback.json"
aws_error_file="${temporary_directory}/aws-error"
mutation_attempted=0
completed=0

python3 - "${predecessor_file}" "${expected_file}" <<'PY'
import json
import os
import sys
from pathlib import Path

resource = os.environ["SES_IDENTITY_ARN"]
base = {
    "Effect": "Allow",
    "Action": ["ses:SendEmail", "ses:SendRawEmail"],
    "Resource": resource,
}
predecessor = {
    "Version": "2012-10-17",
    "Statement": [{
        **base,
        "Sid": "ExactSimulatorDelivery",
        "Condition": {
            "StringEquals": {"ses:FromAddress": "no-reply@they.dev"},
            "ForAllValues:StringEquals": {
                "ses:Recipients": ["success@simulator.amazonses.com"],
            },
            "Null": {"ses:Recipients": "false"},
        },
    }],
}
expected = {
    "Version": "2012-10-17",
    "Statement": [{
        **base,
        "Sid": "ExactSenderDelivery",
        "Condition": {
            "StringEquals": {"ses:FromAddress": "no-reply@they.dev"},
        },
    }],
}
for target, document in zip(sys.argv[1:], (predecessor, expected), strict=True):
    Path(target).write_text(json.dumps(document, separators=(",", ":")), encoding="utf-8")
PY
chmod 600 "${predecessor_file}" "${expected_file}"

canonical_equal() {
  python3 - "$1" "$2" <<'PY'
import json
import sys
from pathlib import Path

left = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
right = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
raise SystemExit(0 if left == right else 1)
PY
}

read_policy() {
  local output_file="$1"
  aws iam get-role-policy \
    --role-name "${WORKLOAD_ROLE_NAME}" \
    --policy-name "${policy_name}" \
    --query PolicyDocument \
    --output json >"${output_file}" 2>"${aws_error_file}"
}

cleanup() {
  local original_status=$?
  local rollback_failed=0
  trap - EXIT HUP INT TERM
  if [[ "${completed}" -ne 1 && "${mutation_attempted}" -eq 1 ]]; then
    if read_policy "${readback_file}"; then
      if canonical_equal "${predecessor_file}" "${readback_file}"; then
        :
      elif canonical_equal "${expected_file}" "${readback_file}"; then
        if aws iam put-role-policy \
          --role-name "${WORKLOAD_ROLE_NAME}" \
          --policy-name "${policy_name}" \
          --policy-document "file://${predecessor_file}" >/dev/null \
          && read_policy "${readback_file}" \
          && canonical_equal "${predecessor_file}" "${readback_file}"; then
          :
        else
          rollback_failed=1
        fi
      else
        rollback_failed=1
      fi
    else
      rollback_failed=1
    fi
  fi
  rm -f "${temporary_directory}"/*
  rmdir "${temporary_directory}" 2>/dev/null || true
  if [[ "${rollback_failed}" -ne 0 ]]; then
    echo "SES policy rollback could not be confirmed; stop before continuing." >&2
    exit 1
  fi
  exit "${original_status}"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

inline_policies="$(aws iam list-role-policies \
  --role-name "${WORKLOAD_ROLE_NAME}" \
  --query PolicyNames \
  --output json)"
attached_policies="$(aws iam list-attached-role-policies \
  --role-name "${WORKLOAD_ROLE_NAME}" \
  --query AttachedPolicies \
  --output json)"
python3 - "${policy_name}" "${inline_policies}" "${attached_policies}" <<'PY'
import json
import sys

expected_name = sys.argv[1]
inline = json.loads(sys.argv[2])
attached = json.loads(sys.argv[3])
if inline != [expected_name] or attached != []:
    raise SystemExit("dedicated workload role has policies outside the exact approved set")
PY

if ! read_policy "${current_file}"; then
  cat "${aws_error_file}" >&2
  exit 1
fi
if canonical_equal "${expected_file}" "${current_file}"; then
  completed=1
  echo "SES recipient policy is already at the exact sender-bound state."
  exit 0
fi
canonical_equal "${predecessor_file}" "${current_file}" || {
  echo "Existing SES policy is neither the exact predecessor nor the approved target." >&2
  exit 1
}

mutation_attempted=1
if ! aws iam put-role-policy \
  --role-name "${WORKLOAD_ROLE_NAME}" \
  --policy-name "${policy_name}" \
  --policy-document "file://${expected_file}" >/dev/null; then
  if ! read_policy "${readback_file}" || ! canonical_equal "${expected_file}" "${readback_file}"; then
    echo "SES policy update failed without an exact target-state read-back." >&2
    exit 1
  fi
fi
read_policy "${readback_file}"
canonical_equal "${expected_file}" "${readback_file}" || {
  echo "SES policy update did not converge to the exact approved target." >&2
  exit 1
}

completed=1
echo "Updated the exact simulator-only SES policy to the approved sender-bound policy."
