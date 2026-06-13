#!/usr/bin/env node

const baseUrl = (process.env.BASE_URL || 'https://om.they.dev').replace(/\/+$/, '')
const email = process.env.SMOKE_TEST_EMAIL || ''
const password = process.env.SMOKE_TEST_PASSWORD || ''
const smokePaths = (process.env.SMOKE_TEST_PATHS || '/backend')
  .split(/[\s,]+/)
  .map((value) => value.trim())
  .filter(Boolean)

function fail(message) {
  console.error(`[baseline-smoke] ${message}`)
  process.exit(1)
}

function splitSetCookieHeader(value) {
  if (!value) return []
  const cookies = []
  let current = ''
  let inExpires = false
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    const next = value.slice(index, index + 9).toLowerCase()
    if (next === 'expires=') {
      inExpires = true
    }
    if (inExpires && char === ';') {
      inExpires = false
    }
    if (char === ',' && !inExpires) {
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

if (!email) fail('Missing required environment variable: SMOKE_TEST_EMAIL')
if (!password) fail('Missing required environment variable: SMOKE_TEST_PASSWORD')

console.log(`[baseline-smoke] Using BASE_URL=${baseUrl}`)

const loginPageResponse = await fetch(`${baseUrl}/login`, {
  headers: { 'accept-language': 'en-US,en;q=0.9' },
})
if (!loginPageResponse.ok) {
  fail(`Login page returned HTTP ${loginPageResponse.status}`)
}
console.log('[baseline-smoke] Login page is reachable')

const loginBody = new URLSearchParams({
  email,
  password,
  remember: '0',
})
const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
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
  fail(`Authenticated login failed with HTTP ${loginResponse.status}`)
}

const cookieHeader = extractSetCookies(loginResponse.headers)
  .map((cookie) => cookie.split(';')[0])
  .filter(Boolean)
  .join('; ')
if (!cookieHeader.includes('auth_token=')) {
  fail('Authenticated login did not return auth_token cookie')
}
console.log('[baseline-smoke] Authenticated login succeeded')

for (const smokePath of smokePaths) {
  const normalizedPath = smokePath.startsWith('/') ? smokePath : `/${smokePath}`
  const response = await fetch(`${baseUrl}${normalizedPath}`, {
    headers: {
      cookie: cookieHeader,
      'accept-language': 'en-US,en;q=0.9',
    },
  })
  if (!response.ok) {
    fail(`${normalizedPath} returned HTTP ${response.status}`)
  }
  if (response.url && new URL(response.url).pathname === '/login') {
    fail(`${normalizedPath} redirected to /login`)
  }
  console.log(`[baseline-smoke] Authenticated page is reachable: ${normalizedPath}`)
}

process.exit(0)
