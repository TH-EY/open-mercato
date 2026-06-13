import test from 'node:test'
import assert from 'node:assert/strict'

import {
  parseSmokePaths,
  runSmoke,
  splitSetCookieHeader,
} from '../smoke-auth-dashboard.mjs'

function makeHeaders(cookies) {
  return {
    getSetCookie() {
      return cookies
    },
  }
}

function makeResponse({ ok = true, status = 200, url = 'https://preview.example.test/backend', body = '', headers = makeHeaders([]) } = {}) {
  return {
    ok,
    status,
    url,
    headers,
    async text() {
      return body
    },
  }
}

test('parseSmokePaths accepts whitespace and comma separated paths', () => {
  assert.deepEqual(
    parseSmokePaths('/backend/projects /backend/projects/templates,/backend/projects/create'),
    ['/backend/projects', '/backend/projects/templates', '/backend/projects/create'],
  )
})

test('splitSetCookieHeader preserves Expires commas', () => {
  const cookies = splitSetCookieHeader(
    'auth_token=abc; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT, session_token=def; Path=/; HttpOnly',
  )

  assert.deepEqual(cookies, [
    'auth_token=abc; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT',
    'session_token=def; Path=/; HttpOnly',
  ])
})

test('runSmoke logs in with form payload and checks authenticated pages', async () => {
  const calls = []
  const logs = []
  const fetch = async (url, init = {}) => {
    calls.push({ url, init })
    if (url === 'https://preview.example.test/login') {
      return makeResponse({ url })
    }
    if (url === 'https://preview.example.test/api/auth/login') {
      assert.equal(init.method, 'POST')
      assert.equal(init.headers['content-type'], 'application/x-www-form-urlencoded')
      assert.equal(init.headers['accept-language'], 'en-US,en;q=0.9')
      assert.ok(init.body instanceof URLSearchParams)
      assert.equal(init.body.get('email'), 'admin@example.test')
      assert.equal(init.body.get('password'), 'secret-password')
      assert.equal(init.body.get('remember'), '0')
      return makeResponse({
        url,
        body: JSON.stringify({ ok: true }),
        headers: makeHeaders([
          'auth_token=abc; Path=/; HttpOnly',
          'session_token=def; Path=/; HttpOnly',
        ]),
      })
    }
    if (url === 'https://preview.example.test/backend/projects') {
      assert.equal(init.headers.cookie, 'auth_token=abc; session_token=def')
      assert.equal(init.headers['accept-language'], 'en-US,en;q=0.9')
      return makeResponse({ url })
    }
    if (url === 'https://preview.example.test/backend/projects/templates') {
      assert.equal(init.headers.cookie, 'auth_token=abc; session_token=def')
      return makeResponse({ url })
    }
    throw new Error(`unexpected fetch ${url}`)
  }

  await runSmoke({
    fetch,
    log: (message) => logs.push(message),
    env: {
      BASE_URL: 'https://preview.example.test/',
      SMOKE_TEST_EMAIL: 'admin@example.test',
      SMOKE_TEST_PASSWORD: 'secret-password',
      SMOKE_TEST_PATHS: '/backend/projects /backend/projects/templates',
    },
  })

  assert.deepEqual(
    calls.map((call) => call.url),
    [
      'https://preview.example.test/login',
      'https://preview.example.test/api/auth/login',
      'https://preview.example.test/backend/projects',
      'https://preview.example.test/backend/projects/templates',
    ],
  )
  assert.deepEqual(logs, [
    '[baseline-smoke] Using BASE_URL=https://preview.example.test',
    '[baseline-smoke] Login page is reachable',
    '[baseline-smoke] Authenticated login succeeded',
    '[baseline-smoke] Authenticated page is reachable: /backend/projects',
    '[baseline-smoke] Authenticated page is reachable: /backend/projects/templates',
  ])
})

test('runSmoke fails when authenticated page redirects to login', async () => {
  const fetch = async (url) => {
    if (url.endsWith('/api/auth/login')) {
      return makeResponse({
        url,
        body: JSON.stringify({ ok: true }),
        headers: makeHeaders(['auth_token=abc; Path=/']),
      })
    }
    if (url.endsWith('/login')) return makeResponse({ url })
    return makeResponse({ url: 'https://preview.example.test/login' })
  }

  await assert.rejects(
    runSmoke({
      fetch,
      log: () => {},
      env: {
        BASE_URL: 'https://preview.example.test',
        SMOKE_TEST_EMAIL: 'admin@example.test',
        SMOKE_TEST_PASSWORD: 'secret-password',
        SMOKE_TEST_PATHS: '/backend/projects',
      },
    }),
    /redirected to \/login/,
  )
})
