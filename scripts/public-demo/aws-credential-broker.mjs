import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts'
import { createHash, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer, get as httpsGet } from 'node:https'
import { pathToFileURL } from 'node:url'

const DEFAULT_PATH = '/credentials'
const DEFAULT_PORT = 4790
const DEFAULT_REFRESH_WINDOW_MS = 5 * 60 * 1000
const DEFAULT_STS_TIMEOUT_MS = 5_000

function requiredEnvironment(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function parsePositiveInteger(value, fallback, name) {
  if (value === undefined || value === '') return fallback
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a positive integer`)
  const parsed = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed
}

function validateRoleArn(roleArn) {
  if (!/^arn:(aws|aws-us-gov|aws-cn):iam::\d{12}:role\/[A-Za-z0-9+=,.@_\/-]+$/.test(roleArn)) {
    throw new Error('AWS_CREDENTIAL_BROKER_ROLE_ARN is invalid')
  }
  return roleArn
}

function credentialResponse(credentials, now, refreshWindowMs) {
  const expiration = credentials?.Expiration instanceof Date
    ? credentials.Expiration
    : new Date(credentials?.Expiration ?? '')
  const expirationTime = expiration.getTime()
  if (
    !credentials?.AccessKeyId ||
    !credentials?.SecretAccessKey ||
    !credentials?.SessionToken ||
    !Number.isFinite(expirationTime) ||
    expirationTime <= now() + refreshWindowMs
  ) {
    throw new Error('AssumeRole returned incomplete or short-lived credentials')
  }

  return Object.freeze({
    AccessKeyId: credentials.AccessKeyId,
    SecretAccessKey: credentials.SecretAccessKey,
    Token: credentials.SessionToken,
    Expiration: expiration.toISOString(),
  })
}

export function createCredentialCache({
  assumeRole,
  now = Date.now,
  refreshWindowMs = DEFAULT_REFRESH_WINDOW_MS,
}) {
  let cached
  let refreshPromise

  async function refresh() {
    const response = await assumeRole()
    const next = credentialResponse(response?.Credentials, now, refreshWindowMs)
    cached = next
    return next
  }

  return {
    async get() {
      const expirationTime = cached ? Date.parse(cached.Expiration) : 0
      if (expirationTime > now() + refreshWindowMs) return cached

      if (!refreshPromise) {
        refreshPromise = refresh().finally(() => {
          refreshPromise = undefined
        })
      }
      return refreshPromise
    },
  }
}

function tokenDigest(value) {
  return createHash('sha256').update(value, 'utf8').digest()
}

export function createAuthorizationCheck(expectedToken) {
  const expectedDigest = tokenDigest(`Bearer ${expectedToken}`)
  return (authorizationHeader) => {
    const supplied = typeof authorizationHeader === 'string' ? authorizationHeader : ''
    return timingSafeEqual(expectedDigest, tokenDigest(supplied))
  }
}

function sendJson(response, statusCode, body, additionalHeaders = {}) {
  const payload = JSON.stringify(body)
  response.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
    'content-type': 'application/json',
    ...additionalHeaders,
  })
  response.end(payload)
}

export function createCredentialBrokerServer({ key, certificate, token, credentialCache }) {
  const isAuthorized = createAuthorizationCheck(token)
  const server = createServer({ key, cert: certificate }, async (request, response) => {
    if (request.method !== 'GET' || request.url !== DEFAULT_PATH) {
      sendJson(response, 404, { error: 'not_found' })
      return
    }
    if (!isAuthorized(request.headers.authorization)) {
      sendJson(response, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' })
      return
    }

    try {
      sendJson(response, 200, await credentialCache.get())
    } catch {
      sendJson(response, 503, { error: 'credentials_unavailable' })
    }
  })
  server.headersTimeout = 5_000
  server.requestTimeout = 5_000
  server.keepAliveTimeout = 5_000
  server.maxHeadersCount = 20
  return server
}

async function assumeWorkloadRole({ region, roleArn, timeoutMs }) {
  const client = new STSClient({ region, maxAttempts: 2 })
  return async () => {
    const abortController = new AbortController()
    const timeout = setTimeout(() => abortController.abort(), timeoutMs)
    try {
      return await client.send(new AssumeRoleCommand({
        RoleArn: roleArn,
        RoleSessionName: 'openmercato-public-demo',
        DurationSeconds: 900,
      }), { abortSignal: abortController.signal })
    } finally {
      clearTimeout(timeout)
    }
  }
}

export async function startBroker() {
  const region = requiredEnvironment('AWS_REGION')
  const roleArn = validateRoleArn(requiredEnvironment('AWS_CREDENTIAL_BROKER_ROLE_ARN'))
  const bindAddress = requiredEnvironment('AWS_CREDENTIAL_BROKER_BIND_ADDRESS')
  const port = parsePositiveInteger(process.env.AWS_CREDENTIAL_BROKER_PORT, DEFAULT_PORT, 'AWS_CREDENTIAL_BROKER_PORT')
  const timeoutMs = parsePositiveInteger(
    process.env.AWS_CREDENTIAL_BROKER_STS_TIMEOUT_MS,
    DEFAULT_STS_TIMEOUT_MS,
    'AWS_CREDENTIAL_BROKER_STS_TIMEOUT_MS',
  )
  const token = (await readFile(requiredEnvironment('AWS_CREDENTIAL_BROKER_TOKEN_FILE'), 'utf8')).trim()
  if (!/^[A-Za-z0-9._~-]{32,512}$/.test(token)) throw new Error('Broker token is invalid')

  const credentialCache = createCredentialCache({
    assumeRole: await assumeWorkloadRole({ region, roleArn, timeoutMs }),
  })
  await credentialCache.get()

  const [key, certificate] = await Promise.all([
    readFile(requiredEnvironment('AWS_CREDENTIAL_BROKER_TLS_KEY_FILE')),
    readFile(requiredEnvironment('AWS_CREDENTIAL_BROKER_TLS_CERT_FILE')),
  ])
  const server = createCredentialBrokerServer({ key, certificate, token, credentialCache })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, bindAddress, resolve)
  })

  const stop = () => server.close(() => process.exit(0))
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  process.stdout.write('AWS credential broker is ready.\n')
  return server
}

export async function runHealthcheck() {
  const token = (await readFile(requiredEnvironment('AWS_CREDENTIAL_BROKER_TOKEN_FILE'), 'utf8')).trim()
  const port = parsePositiveInteger(process.env.AWS_CREDENTIAL_BROKER_PORT, DEFAULT_PORT, 'AWS_CREDENTIAL_BROKER_PORT')
  const bindAddress = requiredEnvironment('AWS_CREDENTIAL_BROKER_BIND_ADDRESS')
  await new Promise((resolve, reject) => {
    const request = httpsGet({
      hostname: bindAddress,
      servername: 'public-demo-aws-credential-broker',
      port,
      path: DEFAULT_PATH,
      headers: { authorization: `Bearer ${token}` },
      timeout: 3_000,
    }, (response) => {
      response.resume()
      response.once('end', () => response.statusCode === 200
        ? resolve()
        : reject(new Error('Broker healthcheck failed')))
    })
    request.once('timeout', () => request.destroy(new Error('Broker healthcheck timed out')))
    request.once('error', reject)
  })
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  const operation = process.argv[2] === '--healthcheck' ? runHealthcheck : startBroker
  operation().catch(() => {
    process.stderr.write('AWS credential broker failed.\n')
    process.exitCode = 1
  })
}
