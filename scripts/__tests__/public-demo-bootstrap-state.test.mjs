import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'
import {
  classifyIdentityRows,
  emailHashCandidates,
} from '../public-demo/bootstrap-state.mjs'

const identities = [
  { email: 'superadmin@public-demo.invalid', role: 'superadmin' },
  { email: 'admin@public-demo.invalid', role: 'admin' },
  { email: 'employee@public-demo.invalid', role: 'employee' },
]

function exactRows() {
  return identities.map((identity, index) => ({
    id: `user-${index}`,
    email: identity.email,
    email_hash: null,
    tenant_id: 'tenant-1',
    organization_id: 'organization-1',
    roles: [identity.role],
  }))
}

test('identity classifier accepts only the exact three identities, scope, and one-role mappings', () => {
  assert.equal(classifyIdentityRows([], identities), 'empty')
  assert.equal(classifyIdentityRows(exactRows(), identities), 'initialized')

  const extra = [...exactRows(), { ...exactRows()[0], id: 'user-extra' }]
  assert.equal(classifyIdentityRows(extra, identities), 'drift')

  const wrongRole = exactRows()
  wrongRole[2].roles = ['admin', 'employee']
  assert.equal(classifyIdentityRows(wrongRole, identities), 'drift')

  const wrongScope = exactRows()
  wrongScope[1].tenant_id = 'tenant-2'
  assert.equal(classifyIdentityRows(wrongScope, identities), 'drift')
})

test('identity classifier matches encrypted-email lookup hashes without exposing plaintext', () => {
  const previousKey = process.env.TENANT_DATA_ENCRYPTION_KEY
  process.env.TENANT_DATA_ENCRYPTION_KEY = 'test-tenant-encryption-key'
  try {
    const rows = exactRows().map((row, index) => ({
      ...row,
      email: `ciphertext-${index}`,
      email_hash: emailHashCandidates(identities[index].email)[0],
    }))
    assert.equal(classifyIdentityRows(rows, identities), 'initialized')
    assert.match(rows[0].email_hash, /^v2:[0-9a-f]{64}$/)
  } finally {
    if (previousKey === undefined) delete process.env.TENANT_DATA_ENCRYPTION_KEY
    else process.env.TENANT_DATA_ENCRYPTION_KEY = previousKey
  }
})

test('lookup hashes retain the legacy candidate for recovery across hash-key migration', () => {
  const previousKey = process.env.TENANT_DATA_ENCRYPTION_KEY
  process.env.TENANT_DATA_ENCRYPTION_KEY = 'test-tenant-encryption-key'
  try {
    const candidates = emailHashCandidates('Admin@Public-Demo.Invalid')
    const legacy = crypto.createHash('sha256').update('admin@public-demo.invalid').digest('hex')
    assert.deepEqual(candidates, [
      `v2:${crypto.createHmac('sha256', 'test-tenant-encryption-key').update('admin@public-demo.invalid').digest('hex')}`,
      legacy,
    ])
  } finally {
    if (previousKey === undefined) delete process.env.TENANT_DATA_ENCRYPTION_KEY
    else process.env.TENANT_DATA_ENCRYPTION_KEY = previousKey
  }
})
