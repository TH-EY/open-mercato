#!/usr/bin/env bash
set -euo pipefail

umask 077
export AWS_PAGER=""

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "${name} is required." >&2
    exit 1
  fi
}

command -v aws >/dev/null 2>&1 || { echo "aws is required." >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "python3 is required." >&2; exit 1; }
require_env AWS_REGION

temporary_directory="$(mktemp -d)"
cleanup() {
  rm -f "${temporary_directory}"/*.json
  rmdir "${temporary_directory}" 2>/dev/null || true
}
trap cleanup EXIT HUP INT TERM

parameter_specs=(
  "postgres-password"
  "jwt-secret"
  "tenant-data-encryption-key"
  "meilisearch-master-key"
  "initial-admin-password"
  "admin-password"
  "employee-password"
  "om-hub-oauth-state-key"
)

for parameter_leaf in "${parameter_specs[@]}"; do
  parameter_name="/openmercato-public-demo/runtime/${parameter_leaf}"
  metadata="$(aws ssm describe-parameters \
    --region "${AWS_REGION}" \
    --parameter-filters "Key=Name,Option=Equals,Values=${parameter_name}" \
    --output json)"

  metadata_state="$(python3 -c '
import json, sys
parameters = json.load(sys.stdin).get("Parameters", [])
if not parameters:
    print("absent")
elif len(parameters) == 1 and parameters[0].get("Name") == sys.argv[1] and parameters[0].get("Type") == "SecureString" and parameters[0].get("Tier", "Standard") == "Standard":
    print("exact")
else:
    print("drift")
' "${parameter_name}" <<<"${metadata}")"

  case "${metadata_state}" in
    exact)
      echo "Reusing existing Standard SecureString ${parameter_name}."
      continue
      ;;
    drift)
      echo "Parameter collision or drift at ${parameter_name}; refusing to overwrite." >&2
      exit 1
      ;;
    absent) ;;
    *)
      echo "Unexpected parameter metadata state for ${parameter_name}." >&2
      exit 1
      ;;
  esac

  if ! IFS= read -r parameter_value || [[ -z "${parameter_value}" ]]; then
    echo "One non-empty secret value is required on stdin for absent parameter ${parameter_name}." >&2
    exit 1
  fi
  payload_file="${temporary_directory}/${parameter_leaf}.json"
  printf '%s' "${parameter_value}" | python3 -c '
import json
import sys
from pathlib import Path

value = sys.stdin.read()
if not value or "\n" in value or "\r" in value:
    raise SystemExit("secret value must be one non-empty line")
Path(sys.argv[1]).write_text(
    json.dumps(
        {
            "Name": sys.argv[2],
            "Value": value,
            "Type": "SecureString",
            "Tier": "Standard",
            "Overwrite": False,
        }
    ),
    encoding="utf-8",
)
' "${payload_file}" "${parameter_name}"
  parameter_value=""
  chmod 600 "${payload_file}"
  aws ssm put-parameter \
    --region "${AWS_REGION}" \
    --cli-input-json "file://${payload_file}" \
    --output json >/dev/null
  rm -f "${payload_file}"
  echo "Created Standard SecureString ${parameter_name}."
done

echo "Public-demo runtime parameter metadata is present; values were not read back."
