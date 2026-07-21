import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve('infra/aws-upstream-baseline')
const reader = path.join(root, 'read-dotenv-value.py')
const privateWriter = path.join(root, 'write-private-file.py')
const postgresSqlRenderer = path.join(root, 'render-postgres-password-sql.py')
const emailHashSqlRenderer = path.join(root, 'render-postgres-email-hashes-exists-sql.py')

test('dotenv reader returns values as inert data', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'om-dotenv-reader-'))
  const envPath = path.join(directory, '.env')
  const sentinel = '$(printf should-not-run)'
  fs.writeFileSync(envPath, `SAFE=value\nSECRET=${sentinel}\n`, { mode: 0o600 })

  try {
    assert.equal(execFileSync('python3', [reader, envPath, 'SECRET'], { encoding: 'utf8' }), sentinel)
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

test('email hash SQL renderer accepts only bounded digest input', () => {
  const valid = spawnSync('python3', [emailHashSqlRenderer, 'admin'], {
    input: `${'a'.repeat(64)}\nv2:${'b'.repeat(64)}\n`,
    encoding: 'utf8',
  })
  assert.equal(valid.status, 0, valid.stderr)
  assert.match(valid.stdout, /from users u/)
  assert.match(valid.stdout, /join user_roles/)
  assert.match(valid.stdout, /r\.name = 'admin'/)

  const invalid = spawnSync('python3', [emailHashSqlRenderer, 'admin'], {
    input: "x'); drop table users; --\n",
    encoding: 'utf8',
  })
  assert.notEqual(invalid.status, 0)
})

test('private writer atomically replaces a world-readable file with mode 0600', () => {
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

test('private writer preserves the existing file on empty or incomplete input', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'om-private-writer-failure-'))
  const target = path.join(directory, '.env')
  fs.writeFileSync(target, 'POSTGRES_PASSWORD=preserved\n', { mode: 0o600 })

  try {
    const empty = spawnSync('python3', [privateWriter, target], { input: '', encoding: 'utf8' })
    assert.notEqual(empty.status, 0)
    assert.equal(fs.readFileSync(target, 'utf8'), 'POSTGRES_PASSWORD=preserved\n')

    const incomplete = spawnSync(
      'python3',
      [privateWriter, target, '--required-key', 'POSTGRES_PASSWORD', '--required-key', 'AUTH_SECRET'],
      { input: 'POSTGRES_PASSWORD=new-value\n', encoding: 'utf8' },
    )
    assert.notEqual(incomplete.status, 0)
    assert.equal(fs.readFileSync(target, 'utf8'), 'POSTGRES_PASSWORD=preserved\n')
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
