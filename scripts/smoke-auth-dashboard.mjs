#!/usr/bin/env node

import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function splitSetCookieHeader(value) {
  if (!value) return []
  const cookies = []
  let current = ''
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    const remaining = value.slice(index + 1)
    const beginsNextCookie = /^\s*[!#$%&'*+\-.^_`|~0-9A-Za-z]+=/.test(remaining)
    if (char === ',' && beginsNextCookie) {
      cookies.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  if (current.trim()) cookies.push(current.trim())
  return cookies
}

function extractSetCookies(headers) {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie()
  return splitSetCookieHeader(headers.get('set-cookie') || '')
}

async function readText(response) {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

function resolveRequestTimeout(env) {
  const rawValue = env.SMOKE_REQUEST_TIMEOUT_MS || '10000'
  if (!/^\d+$/.test(rawValue)) {
    throw new Error('SMOKE_REQUEST_TIMEOUT_MS must be an integer between 1 and 60000')
  }
  const timeoutMs = Number(rawValue)
  if (timeoutMs < 1 || timeoutMs > 60000) {
    throw new Error('SMOKE_REQUEST_TIMEOUT_MS must be an integer between 1 and 60000')
  }
  return timeoutMs
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs, readBody = false) {
  const controller = new AbortController()
  let timeoutId
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort()
      reject(new Error(`Request timed out after ${timeoutMs}ms`))
    }, timeoutMs)
  })
  try {
    return await Promise.race([
      Promise.resolve().then(async () => {
        const response = await fetchImpl(url, { ...options, signal: controller.signal })
        return {
          response,
          text: readBody ? await readText(response) : '',
        }
      }),
      timeoutPromise,
    ])
  } finally {
    clearTimeout(timeoutId)
  }
}

export async function runSmoke(options = {}) {
  const env = options.env ?? process.env
  const fetchImpl = options.fetch ?? globalThis.fetch
  const log = options.log ?? console.log
  const baseUrl = (env.BASE_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '')
  const email = env.SMOKE_TEST_EMAIL || ''
  const password = env.SMOKE_TEST_PASSWORD || ''
  const expectedRole = env.EXPECTED_ROLE || ''
  const tenantId = env.SMOKE_TEST_TENANT_ID || ''
  const requireTenantScope = env.REQUIRE_TENANT_SCOPE === 'true'
  const requestTimeoutMs = resolveRequestTimeout(env)

  if (!email) throw new Error('Missing required environment variable: SMOKE_TEST_EMAIL')
  if (!password) throw new Error('Missing required environment variable: SMOKE_TEST_PASSWORD')
  if (!expectedRole) throw new Error('Missing required environment variable: EXPECTED_ROLE')
  if (requireTenantScope && !tenantId) {
    throw new Error('Missing required environment variable: SMOKE_TEST_TENANT_ID')
  }

  const loginUrl = tenantId
    ? `${baseUrl}/login?tenant=${encodeURIComponent(tenantId)}`
    : `${baseUrl}/login`
  const { response: loginPageResponse } = await fetchWithTimeout(fetchImpl, loginUrl, {
    headers: { 'accept-language': 'en-US,en;q=0.9' },
  }, requestTimeoutMs)
  if (!loginPageResponse.ok) throw new Error(`Login page returned HTTP ${loginPageResponse.status}`)

  const loginBody = new URLSearchParams({ email, password, remember: '0' })
  if (tenantId) loginBody.set('tenantId', tenantId)
  const { response: loginResponse, text: loginText } = await fetchWithTimeout(fetchImpl, `${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'accept-language': 'en-US,en;q=0.9',
    },
    body: loginBody,
  }, requestTimeoutMs, true)
  let loginJson = null
  try {
    loginJson = loginText ? JSON.parse(loginText) : null
  } catch {
    loginJson = null
  }
  if (!loginResponse.ok || loginJson?.ok !== true) {
    throw new Error(`Authenticated login failed with HTTP ${loginResponse.status}`)
  }

  const cookieHeader = extractSetCookies(loginResponse.headers)
    .map((cookie) => cookie.split(';')[0])
    .filter(Boolean)
    .join('; ')
  if (!cookieHeader.includes('auth_token=')) {
    throw new Error('Authenticated login did not return auth_token cookie')
  }

  const { response: profileResponse, text: profileText } = await fetchWithTimeout(fetchImpl, `${baseUrl}/api/auth/profile`, {
    headers: { cookie: cookieHeader, 'accept-language': 'en-US,en;q=0.9' },
  }, requestTimeoutMs, true)
  let profile = null
  try {
    profile = profileText ? JSON.parse(profileText) : null
  } catch {
    profile = null
  }
  if (!profileResponse.ok || profile?.email !== email || !profile?.roles?.includes(expectedRole)) {
    throw new Error(`Authenticated profile did not prove ${expectedRole} access`)
  }

  const { response: dashboardResponse } = await fetchWithTimeout(fetchImpl, `${baseUrl}/backend`, {
    headers: { cookie: cookieHeader, 'accept-language': 'en-US,en;q=0.9' },
  }, requestTimeoutMs)
  if (!dashboardResponse.ok) {
    throw new Error(`Authenticated dashboard returned HTTP ${dashboardResponse.status}`)
  }
  if (dashboardResponse.url && new URL(dashboardResponse.url).pathname === '/login') {
    throw new Error('Authenticated dashboard redirected to /login')
  }

  log(`[finoo-smoke] Authenticated ${expectedRole} access verified`)
}

const isDirectRun =
  process.argv.includes('--run-smoke') ||
  (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))

if (isDirectRun) {
  runSmoke().catch((error) => {
    console.error(`[finoo-smoke] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
