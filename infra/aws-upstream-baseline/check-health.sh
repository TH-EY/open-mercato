#!/usr/bin/env bash
set -euo pipefail

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

require_cmd aws
require_cmd curl
require_cmd python3

AWS_REGION="${AWS_REGION:-eu-west-2}"
TARGET_GROUP_ARN="${TARGET_GROUP_ARN:-arn:aws:elasticloadbalancing:eu-west-2:062648047691:targetgroup/openmercato-upstream-baseline-tg/10a6c24bb7e46496}"
BASE_URL="${BASE_URL:-https://om.they.dev}"
HEALTH_PATH="${HEALTH_PATH:-/login}"
OPEN_BROWSER="${OPEN_BROWSER:-0}"

FULL_URL="${BASE_URL%/}${HEALTH_PATH}"

echo "[baseline-health] URL=${FULL_URL}"
echo "[baseline-health] TARGET_GROUP_ARN=${TARGET_GROUP_ARN}"

echo
echo "== DNS =="
python3 - <<'PY' "${BASE_URL}"
import socket, sys
from urllib.parse import urlparse

host = urlparse(sys.argv[1]).hostname or sys.argv[1]
print(host, socket.gethostbyname_ex(host)[2])
PY

echo
echo "== TARGET HEALTH =="
aws elbv2 describe-target-health \
  --region "${AWS_REGION}" \
  --target-group-arn "${TARGET_GROUP_ARN}" \
  --query 'TargetHealthDescriptions[].{id:Target.Id,port:Target.Port,state:TargetHealth.State,reason:TargetHealth.Reason,description:TargetHealth.Description}' \
  --output table

echo
echo "== HTTP CHECK =="
TMP_HEADERS="$(mktemp)"
trap 'rm -f "${TMP_HEADERS}"' EXIT

curl -kfsS -D "${TMP_HEADERS}" -o /dev/null --max-time 20 "${FULL_URL}"
sed -n '1,12p' "${TMP_HEADERS}"

if [[ "${OPEN_BROWSER}" == "1" ]]; then
  if command -v open >/dev/null 2>&1; then
    echo
    echo "== OPENING BROWSER =="
    open "${FULL_URL}"
  else
    echo
    echo "Skipping browser open: 'open' command not available."
  fi
fi

echo
echo "[baseline-health] OK"
