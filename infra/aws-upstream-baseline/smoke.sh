#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-https://om.they.dev}"
export BASE_URL

echo "[baseline-smoke] Checking ${BASE_URL}/login"

status="$(curl -fsS -o /tmp/openmercato-baseline-login-smoke.html -w '%{http_code}' "${BASE_URL}/login")"
case "${status}" in
  2* | 3*)
    echo "[baseline-smoke] /login returned ${status}"
    ;;
  *)
    echo "[baseline-smoke] /login returned ${status}" >&2
    sed -n '1,80p' /tmp/openmercato-baseline-login-smoke.html >&2 || true
    exit 1
    ;;
esac
