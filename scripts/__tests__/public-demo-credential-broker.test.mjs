import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  createCredentialBrokerServer,
  createCredentialCache,
} from '../public-demo/aws-credential-broker.mjs'

function credentials(suffix, expiration) {
  return {
    Credentials: {
      AccessKeyId: `access-${suffix}`,
      SecretAccessKey: `secret-${suffix}`,
      SessionToken: `token-${suffix}`,
      Expiration: new Date(expiration),
    },
  }
}

function generateCertificate() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'public-demo-broker-'))
  const keyFile = path.join(directory, 'key.pem')
  const certificateFile = path.join(directory, 'certificate.pem')
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost',
    '-keyout', keyFile, '-out', certificateFile,
  ], { stdio: 'ignore' })
  return {
    directory,
    key: fs.readFileSync(keyFile),
    certificate: fs.readFileSync(certificateFile),
  }
}

async function request(port, { method = 'GET', pathName = '/credentials', token } = {}) {
  return new Promise((resolve, reject) => {
    const request = https.request({
      hostname: 'localhost',
      port,
      method,
      path: pathName,
      rejectUnauthorized: false,
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }))
    })
    request.once('error', reject)
    request.end()
  })
}

async function resolveWithAwsDefaultChain(port, tls, token) {
  const tokenFile = path.join(tls.directory, 'token')
  const credentialsFile = path.join(tls.directory, 'empty-credentials')
  const configFile = path.join(tls.directory, 'empty-config')
  fs.writeFileSync(tokenFile, `Bearer ${token}`, { mode: 0o600 })
  fs.writeFileSync(credentialsFile, '[default]\n', { mode: 0o600 })
  fs.writeFileSync(configFile, '[default]\n', { mode: 0o600 })
  const environment = { ...process.env }
  for (const name of [
    'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE',
    'AWS_SHARED_CREDENTIALS_FILE', 'AWS_CONFIG_FILE',
  ]) {
    delete environment[name]
  }
  Object.assign(environment, {
    AWS_CONTAINER_CREDENTIALS_FULL_URI: `https://localhost:${port}/credentials`,
    AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: tokenFile,
    AWS_EC2_METADATA_DISABLED: 'true',
    AWS_REGION: 'eu-west-2',
    AWS_SHARED_CREDENTIALS_FILE: credentialsFile,
    AWS_CONFIG_FILE: configFile,
    NODE_EXTRA_CA_CERTS: path.join(tls.directory, 'certificate.pem'),
  })

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--input-type=module',
      '--eval',
      "import { fromHttp } from '@aws-sdk/credential-provider-http'; const value = await fromHttp({ maxRetries: 0, timeout: 3000 })(); process.stdout.write(JSON.stringify(value))",
    ], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout = []
    const stderr = []
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.once('error', reject)
    child.once('exit', (code) => code === 0
      ? resolve(JSON.parse(Buffer.concat(stdout).toString('utf8')))
      : reject(new Error(Buffer.concat(stderr).toString('utf8'))))
  })
}

test('credential cache collapses concurrent refreshes and refreshes before expiration', async () => {
  let now = Date.parse('2026-08-26T00:00:00.000Z')
  let calls = 0
  let release
  const firstRefresh = new Promise((resolve) => { release = resolve })
  const cache = createCredentialCache({
    now: () => now,
    refreshWindowMs: 300_000,
    assumeRole: async () => {
      calls += 1
      if (calls === 1) await firstRefresh
      return credentials(calls, now + 900_000)
    },
  })

  const pending = Array.from({ length: 20 }, () => cache.get())
  release()
  const initial = await Promise.all(pending)
  assert.equal(calls, 1)
  assert.equal(new Set(initial.map((value) => value.AccessKeyId)).size, 1)

  now += 600_001
  const refreshed = await Promise.all(Array.from({ length: 20 }, () => cache.get()))
  assert.equal(calls, 2)
  assert.equal(new Set(refreshed.map((value) => value.AccessKeyId)).size, 1)
  assert.equal(refreshed[0].AccessKeyId, 'access-2')
})

test('credential cache rejects incomplete and near-expiry sessions', async () => {
  const now = Date.parse('2026-08-26T00:00:00.000Z')
  const incomplete = createCredentialCache({
    now: () => now,
    assumeRole: async () => ({ Credentials: { AccessKeyId: 'only-one-field' } }),
  })
  await assert.rejects(incomplete.get(), /incomplete or short-lived/)

  const nearExpiry = createCredentialCache({
    now: () => now,
    assumeRole: async () => credentials('short', now + 299_999),
  })
  await assert.rejects(nearExpiry.get(), /incomplete or short-lived/)
})

test('HTTPS broker serves only the exact authorized GET path without cacheable responses', async () => {
  const tls = generateCertificate()
  const expected = credentials('valid', Date.now() + 900_000).Credentials
  let providerCalls = 0
  const server = createCredentialBrokerServer({
    key: tls.key,
    certificate: tls.certificate,
    token: 'a'.repeat(64),
    credentialCache: {
      async get() {
        providerCalls += 1
        return {
          AccessKeyId: expected.AccessKeyId,
          SecretAccessKey: expected.SecretAccessKey,
          Token: expected.SessionToken,
          Expiration: expected.Expiration.toISOString(),
        }
      },
    },
  })

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const port = server.address().port

    for (const attempt of [
      await request(port),
      await request(port, { token: 'wrong' }),
      await request(port, { token: 'a'.repeat(64), pathName: '/credentials?x=1' }),
      await request(port, { token: 'a'.repeat(64), method: 'POST' }),
    ]) {
      assert.ok([401, 404].includes(attempt.status))
      assert.equal(attempt.headers['cache-control'], 'no-store')
    }
    assert.equal(providerCalls, 0)

    const valid = await request(port, { token: 'a'.repeat(64) })
    assert.equal(valid.status, 200)
    assert.equal(valid.headers['cache-control'], 'no-store')
    assert.deepEqual(valid.body, {
      AccessKeyId: expected.AccessKeyId,
      SecretAccessKey: expected.SecretAccessKey,
      Token: expected.SessionToken,
      Expiration: expected.Expiration.toISOString(),
    })
    assert.equal(providerCalls, 1)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(tls.directory, { recursive: true, force: true })
  }
})

test('HTTPS broker returns a generic 503 without leaking provider errors', async () => {
  const tls = generateCertificate()
  const server = createCredentialBrokerServer({
    key: tls.key,
    certificate: tls.certificate,
    token: 'b'.repeat(64),
    credentialCache: { get: async () => { throw new Error('sensitive-provider-detail') } },
  })

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const response = await request(server.address().port, { token: 'b'.repeat(64) })
    assert.equal(response.status, 503)
    assert.deepEqual(response.body, { error: 'credentials_unavailable' })
    assert.doesNotMatch(JSON.stringify(response), /sensitive-provider-detail/)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(tls.directory, { recursive: true, force: true })
  }
})

test('AWS explicit HTTP credential provider consumes the HTTPS endpoint and token file', async () => {
  const tls = generateCertificate()
  const token = 'c'.repeat(64)
  const expected = credentials('provider', Date.now() + 900_000).Credentials
  const server = createCredentialBrokerServer({
    key: tls.key,
    certificate: tls.certificate,
    token,
    credentialCache: {
      get: async () => ({
        AccessKeyId: expected.AccessKeyId,
        SecretAccessKey: expected.SecretAccessKey,
        Token: expected.SessionToken,
        Expiration: expected.Expiration.toISOString(),
      }),
    },
  })

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const resolved = await resolveWithAwsDefaultChain(server.address().port, tls, token)
    assert.ok(resolved.accessKeyId === expected.AccessKeyId, 'access key did not come from the broker')
    assert.ok(resolved.secretAccessKey === expected.SecretAccessKey, 'secret key did not come from the broker')
    assert.ok(resolved.sessionToken === expected.SessionToken, 'session token did not come from the broker')
    assert.ok(
      new Date(resolved.expiration).toISOString() === expected.Expiration.toISOString(),
      'expiration did not come from the broker',
    )
  } finally {
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(tls.directory, { recursive: true, force: true })
  }
})
