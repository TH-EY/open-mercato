import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const reader = path.resolve('infra/aws-upstream-baseline/read-dotenv-value.py')
const privateWriter = path.resolve('infra/aws-upstream-baseline/write-private-file.py')
const postgresSqlRenderer = path.resolve('infra/aws-upstream-baseline/render-postgres-password-sql.py')
const emailHashesSqlRenderer = path.resolve(
  'infra/aws-upstream-baseline/render-postgres-email-hashes-exists-sql.py',
)

test('dotenv reader returns values as inert data', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'om-dotenv-reader-'))
  const envPath = path.join(directory, '.env')
  const sentinel = '$(printf should-not-run)'
  fs.writeFileSync(envPath, `SAFE=value\nSECRET=${sentinel}\n`, { mode: 0o600 })

  try {
    const output = execFileSync('python3', [reader, envPath, 'SECRET'], { encoding: 'utf8' })
    assert.equal(output, sentinel)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('PostgreSQL password SQL renderer reads the secret from stdin and quotes values', () => {
  const result = spawnSync('python3', [postgresSqlRenderer, 'custom"role'], {
    input: "p'ass",
    encoding: 'utf8',
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(
    result.stdout,
    "set password_encryption = 'scram-sha-256';\nalter role \"custom\"\"role\" login password 'p''ass';\n",
  )
})

test('email existence SQL renderer accepts only application lookup hashes', () => {
  const keyed = `v2:${'a'.repeat(64)}`
  const legacy = 'b'.repeat(64)
  const result = spawnSync('python3', [emailHashesSqlRenderer], {
    input: JSON.stringify([keyed, legacy]),
  })
  const output = result.stdout.toString('utf8')

  assert.equal(result.status, 0, result.stderr.toString('utf8'))
  assert.match(output, /email_hash in \('v2:a{64}', 'b{64}'\)/)

  const invalid = spawnSync('python3', [emailHashesSqlRenderer], {
    input: JSON.stringify(["not-a-hash'); drop table users; --"]),
  })
  assert.notEqual(invalid.status, 0)
})

test('private writer atomically replaces an existing world-readable file with mode 0600', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'om-private-writer-'))
  const target = path.join(directory, '.env')
  fs.writeFileSync(target, 'OLD=value\n', { mode: 0o644 })

  try {
    const result = spawnSync('python3', [privateWriter, target], {
      input: 'SECRET=new-value\n',
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(fs.readFileSync(target, 'utf8'), 'SECRET=new-value\n')
    assert.equal(fs.statSync(target).mode & 0o777, 0o600)
    assert.deepEqual(fs.readdirSync(directory), ['.env'])
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('dotenv reader fails closed on missing or duplicate keys', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'om-dotenv-reader-'))
  const envPath = path.join(directory, '.env')
  fs.writeFileSync(envPath, 'DUPLICATE=one\nDUPLICATE=two\n', { mode: 0o600 })

  try {
    assert.notEqual(spawnSync('python3', [reader, envPath, 'MISSING']).status, 0)
    assert.notEqual(spawnSync('python3', [reader, envPath, 'DUPLICATE']).status, 0)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
