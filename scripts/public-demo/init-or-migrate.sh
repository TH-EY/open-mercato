#!/bin/sh
set -eu

marker_dir="${PUBLIC_DEMO_INIT_MARKER_DIR:-/tmp/init-marker}"
marker_file="${marker_dir}/.seeded-v1"
initialized_file="${marker_dir}/.initialized-v1"
database_guard_file="${marker_dir}/.database-guard-v1"
lock_ready_file="${marker_dir}/.bootstrap-lock-ready"
log_file="${marker_dir}/.bootstrap.log"
ids_file="${marker_dir}/.bootstrap-ids"
state_helper="${PUBLIC_DEMO_BOOTSTRAP_STATE_HELPER:-/app/scripts/public-demo/bootstrap-state.mjs}"
lock_pid=""

umask 077
mkdir -p "${marker_dir}"
: > "${log_file}"
chmod 600 "${log_file}"

cleanup() {
  rm -f "${log_file}" "${ids_file}" "${lock_ready_file}"
  if [ -n "${lock_pid}" ]; then
    kill -TERM "${lock_pid}" 2>/dev/null || true
    wait "${lock_pid}" 2>/dev/null || true
  fi
}
trap cleanup EXIT HUP INT TERM

run_protected() {
  if "$@" >>"${log_file}" 2>&1; then
    return 0
  fi
  echo "Public-demo bootstrap command failed; protected output was removed." >&2
  exit 1
}

if [ ! -f "${database_guard_file}" ]; then
  temporary_guard_file="${database_guard_file}.tmp"
  node --input-type=module - >"${temporary_guard_file}" <<'NODE'
import { randomUUID } from 'node:crypto'
process.stdout.write(`${randomUUID()}\n`)
NODE
  chmod 600 "${temporary_guard_file}"
  mv "${temporary_guard_file}" "${database_guard_file}"
fi
database_guard="$(tr -d '\r\n' < "${database_guard_file}")"

rm -f "${lock_ready_file}"
node "${state_helper}" lock "${lock_ready_file}" >>"${log_file}" 2>&1 &
lock_pid=$!
lock_ready=0
for lock_attempt in $(seq 1 60); do
  if [ -f "${lock_ready_file}" ]; then
    lock_ready=1
    break
  fi
  if ! kill -0 "${lock_pid}" 2>/dev/null; then
    break
  fi
  sleep 1
done
if [ "${lock_ready}" -ne 1 ]; then
  echo "Public-demo bootstrap lock could not be acquired." >&2
  exit 1
fi

bootstrap_state="$(node "${state_helper}" probe "${database_guard}" 2>>"${log_file}")"
if [ -f "${initialized_file}" ]; then
  if [ "${bootstrap_state}" != "initialized" ]; then
    echo "Public-demo initialization marker does not match current database identities." >&2
    exit 1
  fi
else
  if [ "${bootstrap_state}" = "empty" ]; then
    echo "Running first public-demo initialization."
    if yarn mercato init --no-examples >>"${log_file}" 2>&1; then
      bootstrap_state="$(node "${state_helper}" probe "${database_guard}" 2>>"${log_file}" || true)"
    else
      bootstrap_state="$(node "${state_helper}" probe "${database_guard}" 2>>"${log_file}" || true)"
      if [ "${bootstrap_state}" = "empty" ]; then
        echo "Public-demo initialization failed before identity commit; no data was removed and a retry remains safe." >&2
        exit 1
      fi
      if [ "${bootstrap_state}" != "initialized" ]; then
        echo "Public-demo initialization left partial or ambiguous state; data was preserved and continuation requires explicit reconciliation." >&2
        exit 1
      fi
    fi
  fi
  if [ "${bootstrap_state}" != "initialized" ]; then
    echo "Public-demo initialization found partial or ambiguous identity drift; data was preserved." >&2
    exit 1
  fi
  printf '%s\n' "${DEPLOYMENT_SHA:-unknown}" > "${initialized_file}"
  chmod 600 "${initialized_file}"
fi

echo "Running public-demo migrations and convergence."
run_protected yarn db:migrate

node --input-type=module - >"${ids_file}" 2>>"${log_file}" <<'NODE'
import { Client } from 'pg'

const client = new Client({ connectionString: process.env.DATABASE_URL })
await client.connect()
try {
  const result = await client.query(`
    SELECT tenant_id, organization_id
    FROM users
    WHERE deleted_at IS NULL
      AND tenant_id IS NOT NULL
      AND organization_id IS NOT NULL
    GROUP BY tenant_id, organization_id
  `)
  if (result.rows.length !== 1) throw new Error('PUBLIC_DEMO_SCOPE_COUNT_INVALID')
  process.stdout.write(`${result.rows[0].tenant_id} ${result.rows[0].organization_id}\n`)
} finally {
  await client.end()
}
NODE

read -r tenant_id organization_id < "${ids_file}"
case "${tenant_id}:${organization_id}" in
  *[!0-9a-fA-F:-]* | :* | *:)
    echo "Public-demo bootstrap resolved an invalid tenant or organization ID." >&2
    exit 1
    ;;
esac

run_protected yarn mercato configs restore-defaults
run_protected yarn mercato feature_toggles seed-defaults
run_protected yarn mercato auth seed-roles --tenant "${tenant_id}"
run_protected yarn mercato entities seed-encryption --tenant "${tenant_id}" --org "${organization_id}"
run_protected yarn seed:defaults
run_protected yarn mercato auth sync-role-acls --tenant "${tenant_id}"
run_protected yarn mercato dashboards seed-defaults --tenant "${tenant_id}"
run_protected yarn mercato dashboards enable-analytics-widgets --tenant "${tenant_id}" --roles admin,employee
run_protected yarn mercato customers seed-examples --tenant "${tenant_id}" --org "${organization_id}"
run_protected yarn mercato catalog seed-examples-bundle --tenant "${tenant_id}" --org "${organization_id}"
run_protected yarn mercato configs cache structural --all-tenants
run_protected yarn mercato search reindex --tenant "${tenant_id}" --org "${organization_id}" --force
run_protected yarn mercato query_index reindex --force --tenant "${tenant_id}"

node --input-type=module - "${tenant_id}" "${organization_id}" >>"${log_file}" 2>&1 <<'NODE'
import { Client } from 'pg'

const [tenantId, organizationId] = process.argv.slice(2)
const client = new Client({ connectionString: process.env.DATABASE_URL })
await client.connect()
try {
  const userCount = await client.query(`
    SELECT COUNT(*)::integer AS count
    FROM users
    WHERE tenant_id = $1
      AND organization_id = $2
      AND deleted_at IS NULL
  `, [tenantId, organizationId])
  if (userCount.rows[0]?.count !== 3) throw new Error('PUBLIC_DEMO_USER_COUNT_INVALID')

  const roleCounts = await client.query(`
    SELECT r.name, COUNT(*)::integer AS count
    FROM user_roles ur
    JOIN users u ON u.id = ur.user_id
    JOIN roles r ON r.id = ur.role_id
    WHERE u.tenant_id = $1
      AND u.organization_id = $2
      AND u.deleted_at IS NULL
      AND ur.deleted_at IS NULL
      AND r.deleted_at IS NULL
    GROUP BY r.name
    ORDER BY r.name
  `, [tenantId, organizationId])
  const counts = Object.fromEntries(roleCounts.rows.map((row) => [row.name, row.count]))
  if (counts.superadmin !== 1 || counts.admin !== 1 || counts.employee !== 1) {
    throw new Error('PUBLIC_DEMO_ROLE_COUNT_INVALID')
  }
  if (Object.values(counts).reduce((sum, count) => sum + count, 0) !== 3) {
    throw new Error('PUBLIC_DEMO_ROLE_LINK_COUNT_INVALID')
  }
} finally {
  await client.end()
}
NODE

final_bootstrap_state="$(node "${state_helper}" probe "${database_guard}" 2>>"${log_file}")"
if [ "${final_bootstrap_state}" != "initialized" ]; then
  echo "Public-demo identity read-back drifted during convergence." >&2
  exit 1
fi

printf '%s\n' "${DEPLOYMENT_SHA:-unknown}" > "${marker_file}"
chmod 600 "${marker_file}"
echo "Public-demo bootstrap and read-back passed."
