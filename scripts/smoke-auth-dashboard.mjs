#!/usr/bin/env node

import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function parseSmokePaths(value = '/backend') {
  return value
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

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

export function extractSetCookies(headers) {
  if (typeof headers.getSetCookie === 'function') {
    return headers.getSetCookie()
  }
  return splitSetCookieHeader(headers.get('set-cookie') || '')
}

async function readText(response) {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

export async function runSmoke(options = {}) {
  const env = options.env ?? process.env
  const fetchImpl = options.fetch ?? globalThis.fetch
  const log = options.log ?? console.log
  const baseUrl = (env.BASE_URL || 'https://om.they.dev').replace(/\/+$/, '')
  const email = env.SMOKE_TEST_EMAIL || ''
  const password = env.SMOKE_TEST_PASSWORD || ''
  const smokePaths = parseSmokePaths(env.SMOKE_TEST_PATHS || '/backend')

  if (!email) throw new Error('Missing required environment variable: SMOKE_TEST_EMAIL')
  if (!password) throw new Error('Missing required environment variable: SMOKE_TEST_PASSWORD')

  log(`[baseline-smoke] Using BASE_URL=${baseUrl}`)

  const loginPageResponse = await fetchImpl(`${baseUrl}/login`, {
    headers: { 'accept-language': 'en-US,en;q=0.9' },
  })
  if (!loginPageResponse.ok) {
    throw new Error(`Login page returned HTTP ${loginPageResponse.status}`)
  }
  log('[baseline-smoke] Login page is reachable')

  const loginBody = new URLSearchParams({
    email,
    password,
    remember: '0',
  })
  const loginResponse = await fetchImpl(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'accept-language': 'en-US,en;q=0.9',
    },
    body: loginBody,
  })
  const loginText = await readText(loginResponse)
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
  log('[baseline-smoke] Authenticated login succeeded')

  for (const smokePath of smokePaths) {
    const normalizedPath = smokePath.startsWith('/') ? smokePath : `/${smokePath}`
    const response = await fetchImpl(`${baseUrl}${normalizedPath}`, {
      headers: {
        cookie: cookieHeader,
        'accept-language': 'en-US,en;q=0.9',
      },
    })
    if (!response.ok) {
      throw new Error(`${normalizedPath} returned HTTP ${response.status}`)
    }
    if (response.url && new URL(response.url).pathname === '/login') {
      throw new Error(`${normalizedPath} redirected to /login`)
    }
    log(`[baseline-smoke] Authenticated page is reachable: ${normalizedPath}`)
  }
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isDirectRun) {
  runSmoke()
    .then(() => {
      process.exit(0)
    })
    .catch((error) => {
      console.error(`[baseline-smoke] ${error instanceof Error ? error.message : String(error)}`)
      process.exit(1)
    })
}
