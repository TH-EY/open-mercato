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
read -r status time_total < <(curl -k -fsS -o /dev/null -w '%{http_code} %{time_total}' "${BASE_URL%/}/login")
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "login_status=${status}" >> "${GITHUB_OUTPUT}"
  echo "login_time_total=${time_total}" >> "${GITHUB_OUTPUT}"
fi
echo "[baseline-smoke] Login page is reachable (${status}) in ${time_total}s"
