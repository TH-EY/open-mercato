#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"

BASE_URL="${BASE_URL:-https://om.they.dev}"
export BASE_URL

if [[ -z "${SMOKE_TEST_EMAIL:-}" ]]; then
  echo "Missing required environment variable: SMOKE_TEST_EMAIL" >&2
  exit 1
fi

if [[ -z "${SMOKE_TEST_PASSWORD:-}" ]]; then
  echo "Missing required environment variable: SMOKE_TEST_PASSWORD" >&2
  exit 1
fi

if [[ -f "${REPO_ROOT}/scripts/smoke-auth-dashboard.mjs" ]]; then
  exec node "${REPO_ROOT}/scripts/smoke-auth-dashboard.mjs"
fi

echo "[baseline-smoke] Using BASE_URL=${BASE_URL}"
curl_output="$(curl -k -sS -o /dev/null -w '%{http_code} %{time_total}\n' "${BASE_URL%/}/login" || true)"
read -r status time_total <<< "${curl_output:-000 0}"
status="${status:-000}"
time_total="${time_total:-0}"
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "login_status=${status}" >> "${GITHUB_OUTPUT}"
  echo "login_time_total=${time_total}" >> "${GITHUB_OUTPUT}"
fi
if [[ "$status" =~ ^[0-9]{3}$ ]] && [[ "$status" -ge 200 && "$status" -lt 400 ]]; then
  echo "[baseline-smoke] Login page is reachable (${status}) in ${time_total}s"
  exit 0
fi
echo "[baseline-smoke] Login page smoke failed (${status}) in ${time_total}s" >&2
exit 1
