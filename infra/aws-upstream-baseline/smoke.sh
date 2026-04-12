#!/usr/bin/env bash
set -euo pipefail

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

echo "[baseline-smoke] Using BASE_URL=${BASE_URL}"

exec node /Users/patrykmadaj/Sites/open-mercato/scripts/smoke-auth-dashboard.mjs
