import crypto from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { Client } from 'pg'

const expectedDatabase = process.env.PUBLIC_DEMO_DATABASE_NAME ?? 'openmercato_public_demo'
const expectedDatabaseUser = process.env.PUBLIC_DEMO_DATABASE_USER ?? 'openmercato_public_demo'
const expectedIdentities = [
  { email: process.env.OM_INIT_SUPERADMIN_EMAIL, role: 'superadmin' },
  { email: process.env.OM_INIT_ADMIN_EMAIL, role: 'admin' },
  { email: process.env.OM_INIT_EMPLOYEE_EMAIL, role: 'employee' },
]

function lookupPepper() {
  for (const value of [
    process.env.LOOKUP_HASH_PEPPER,
    process.env.TENANT_DATA_ENCRYPTION_FALLBACK_KEY,
    process.env.TENANT_DATA_ENCRYPTION_KEY,
  ]) {
    const normalized = value?.trim().replace(/(?:^['"]|['"]$)/g, '')
    if (normalized) return normalized
  }
  return null
}

export function emailHashCandidates(email) {
  const normalized = email.toLowerCase().trim()
  const legacy = crypto.createHash('sha256').update(normalized).digest('hex')
  const pepper = lookupPepper()
  if (!pepper) return [legacy]
  const current = `v2:${crypto.createHmac('sha256', pepper).update(normalized).digest('hex')}`
  return current === legacy ? [current] : [current, legacy]
}

export function classifyIdentityRows(rows, identities = expectedIdentities) {
  if (rows.length === 0) return 'empty'
  if (rows.length !== identities.length || identities.some((identity) => !identity.email)) return 'drift'

  const matched = new Set()
  let tenantId = null
  let organizationId = null
  for (const identity of identities) {
    const hashes = new Set(emailHashCandidates(identity.email))
    const matches = rows.filter((row) =>
      row.email === identity.email || (typeof row.email_hash === 'string' && hashes.has(row.email_hash)))
    if (matches.length !== 1) return 'drift'
    const row = matches[0]
    if (matched.has(row.id) || !row.tenant_id || !row.organization_id) return 'drift'
    if (tenantId !== null && tenantId !== row.tenant_id) return 'drift'
    if (organizationId !== null && organizationId !== row.organization_id) return 'drift'
    if (!Array.isArray(row.roles) || row.roles.length !== 1 || row.roles[0] !== identity.role) return 'drift'
    matched.add(row.id)
    tenantId = row.tenant_id
    organizationId = row.organization_id
  }
  return 'initialized'
}

async function connectExactDatabase() {
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  const identity = await client.query('SELECT current_database() AS database, current_user AS username')
  if (identity.rows.length !== 1 ||
      identity.rows[0].database !== expectedDatabase ||
      identity.rows[0].username !== expectedDatabaseUser) {
    await client.end()
    throw new Error('PUBLIC_DEMO_DATABASE_IDENTITY_MISMATCH')
  }
  return client
}

async function ensureGuard(client, token) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS public_demo_bootstrap_guard (
      singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
      token uuid NOT NULL
    )
  `)
  await client.query(
    'INSERT INTO public_demo_bootstrap_guard (singleton, token) VALUES (true, $1) ON CONFLICT (singleton) DO NOTHING',
    [token],
  )
  const guard = await client.query('SELECT token::text AS token FROM public_demo_bootstrap_guard')
  if (guard.rows.length !== 1 || guard.rows[0].token !== token) {
    throw new Error('PUBLIC_DEMO_DATABASE_GUARD_MISMATCH')
  }
}

async function tableExists(client, name) {
  const result = await client.query('SELECT to_regclass($1) IS NOT NULL AS present', [`public.${name}`])
  return result.rows[0]?.present === true
}

async function countRows(client, table) {
  if (!(await tableExists(client, table))) return 0
  const result = await client.query(`SELECT COUNT(*)::integer AS count FROM ${table}`)
  return result.rows[0]?.count ?? 0
}

async function probe(client, token) {
  await ensureGuard(client, token)
  if (!(await tableExists(client, 'users'))) {
    const partialCount = (await countRows(client, 'tenants')) + (await countRows(client, 'organizations'))
    return partialCount === 0 ? 'empty' : 'empty-partial'
  }
  const users = await client.query(`
    SELECT
      u.id::text AS id,
      u.email,
      u.email_hash,
      u.tenant_id::text AS tenant_id,
      u.organization_id::text AS organization_id,
      COALESCE(
        json_agg(r.name ORDER BY r.name)
          FILTER (WHERE ur.deleted_at IS NULL AND r.deleted_at IS NULL),
        '[]'::json
      ) AS roles
    FROM users u
    LEFT JOIN user_roles ur ON ur.user_id = u.id AND ur.deleted_at IS NULL
    LEFT JOIN roles r ON r.id = ur.role_id AND r.deleted_at IS NULL
    WHERE u.deleted_at IS NULL
    GROUP BY u.id, u.email, u.email_hash, u.tenant_id, u.organization_id
    ORDER BY u.id
  `)
  const state = classifyIdentityRows(users.rows)
  if (state !== 'empty') return state
  const partialCount = (await countRows(client, 'tenants')) + (await countRows(client, 'organizations'))
  return partialCount === 0 ? 'empty' : 'empty-partial'
}

async function holdLock(readyFile) {
  const client = await connectExactDatabase()
  const lock = await client.query('SELECT pg_try_advisory_lock($1, $2) AS acquired', [710, 113])
  if (lock.rows[0]?.acquired !== true) {
    await client.end()
    throw new Error('PUBLIC_DEMO_BOOTSTRAP_LOCKED')
  }
  await writeFile(readyFile, 'ready\n', { mode: 0o600 })
  await new Promise((resolve) => {
    process.once('SIGTERM', resolve)
    process.once('SIGINT', resolve)
    process.once('SIGHUP', resolve)
  })
  await client.query('SELECT pg_advisory_unlock($1, $2)', [710, 113])
  await client.end()
}

async function main() {
  const [mode, argument] = process.argv.slice(2)
  if (mode === 'lock') {
    if (!argument) throw new Error('PUBLIC_DEMO_LOCK_READY_FILE_REQUIRED')
    await holdLock(argument)
    return
  }
  if (!argument || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(argument)) {
    throw new Error('PUBLIC_DEMO_DATABASE_GUARD_INVALID')
  }
  const client = await connectExactDatabase()
  try {
    if (mode === 'probe') {
      process.stdout.write(`${await probe(client, argument)}\n`)
      return
    }
    throw new Error('PUBLIC_DEMO_BOOTSTRAP_STATE_MODE_INVALID')
  } finally {
    await client.end()
  }
}

if (process.argv[1]?.endsWith('/bootstrap-state.mjs')) {
  main().catch((error) => {
    const code = error instanceof Error && /^PUBLIC_DEMO_[A-Z0-9_]+$/.test(error.message)
      ? error.message
      : 'PUBLIC_DEMO_BOOTSTRAP_STATE_FAILED'
    process.stderr.write(`${code}\n`)
    process.exitCode = 1
  })
}
