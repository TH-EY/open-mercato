const baseUrl = requireEnv('BASE_URL');
const email = requireEnv('SMOKE_TEST_EMAIL');
const password = requireEnv('SMOKE_TEST_PASSWORD');
const tenantId = optionalEnv('SMOKE_TEST_TENANT_ID');

const baseHeaders = {
  accept: 'application/json',
};

const loginResponse = await fetch(new URL('/api/auth/login', baseUrl), {
  method: 'POST',
  headers: {
    ...baseHeaders,
    'content-type': 'application/x-www-form-urlencoded',
  },
  body: new URLSearchParams({
    email,
    password,
    ...(tenantId ? { tenantId } : {}),
  }),
  redirect: 'manual',
});

const loginText = await loginResponse.text();
const loginBody = parseJson(loginText);
const token = typeof loginBody?.token === 'string' && loginBody.token ? loginBody.token : null;
const setCookieHeaders = getSetCookieHeaders(loginResponse);
const cookieHeader = toCookieHeader(setCookieHeaders);

if (!loginResponse.ok) {
  throw new Error(`Login failed with status ${loginResponse.status}: ${truncate(loginText)}`);
}

if (!token && !cookieHeader) {
  throw new Error(`Login succeeded but returned neither token nor cookies: ${truncate(loginText)}`);
}

await assertOk('/api/auth/profile', { token, cookieHeader });
await assertOk('/api/dashboards/layout', { token, cookieHeader });

console.log(`[smoke] Login, profile, and dashboard checks passed for ${baseUrl}`);

async function assertOk(path, auth) {
  const response = await fetch(new URL(path, baseUrl), {
    headers: buildAuthHeaders(auth),
    redirect: 'manual',
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${path} failed with status ${response.status}: ${truncate(text)}`);
  }
  console.log(`[smoke] ${path} -> ${response.status}`);
  return text;
}

function buildAuthHeaders({ token, cookieHeader }) {
  const headers = { ...baseHeaders };
  if (token) headers.authorization = `Bearer ${token}`;
  if (cookieHeader) headers.cookie = cookieHeader;
  return headers;
}

function getSetCookieHeaders(response) {
  if (typeof response.headers.getSetCookie === 'function') {
    return response.headers.getSetCookie();
  }
  const single = response.headers.get('set-cookie');
  return single ? [single] : [];
}

function toCookieHeader(setCookieHeaders) {
  const cookies = setCookieHeaders
    .map((value) => value.split(';', 1)[0]?.trim())
    .filter(Boolean);
  return cookies.length > 0 ? cookies.join('; ') : null;
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function truncate(text) {
  if (!text) return '<empty>';
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name) {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : null;
}
