const dispatch = jest.fn(async () => true)
const findOne = jest.fn(async () => null)
const createdRows: Array<Record<string, unknown>> = []
const integrationEnabled = jest.fn(async () => true)
const encryptedFields = jest.fn(async () => ['payload_json'])
const encryptionEnabled = jest.fn(() => true)
const getDek = jest.fn(async () => ({ key: 'dek' }))
const rateLimitConsume = jest.fn(async () => ({ allowed: true, remainingPoints: 119, msBeforeNext: 60_000, consumedPoints: 1 }))
const secret = 's'.repeat(48)

const em = {
  fork: () => em,
  create: (_entity: unknown, data: Record<string, unknown>) => {
    const row = { id: '123e4567-e89b-41d3-a456-426614174099', ...data }
    createdRows.push(row)
    return row
  },
  persist: () => ({ flush: async () => undefined }),
}

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: async () => ({
    resolve: (name: string) => {
      if (name === 'rateLimiterService') return { trustProxyDepth: 1, consume: rateLimitConsume }
      if (name === 'integrationStateService') return { isEnabled: integrationEnabled }
      if (name === 'integrationCredentialsService') return { resolve: async () => ({ signingSecret: secret }) }
      if (name === 'tenantEncryptionService') return {
        isEnabled: encryptionEnabled,
        getDek,
        getEncryptedFieldNames: encryptedFields,
      }
      if (name === 'em') return em
      throw new Error(`unexpected ${name}`)
    },
  }),
}))
jest.mock('@open-mercato/shared/lib/encryption/find', () => ({ findOneWithDecryption: (...args: unknown[]) => findOne(...args) }))
jest.mock('../../../lib/dispatch', () => ({ dispatchFinooApplicationIntake: (...args: unknown[]) => dispatch(...args) }))

import { POST } from '../route'
import { computeFinooApplicationSignature } from '../../../lib/signature'

const tenantId = '11111111-1111-4111-8111-111111111111'
const organizationId = '22222222-2222-4222-8222-222222222222'

function signedRequest(payload: Record<string, unknown>, messageId = 'nonce_1234567890123456'): Request {
  const body = new TextEncoder().encode(JSON.stringify(payload))
  const timestamp = String(Math.floor(Date.now() / 1000))
  return new Request('http://localhost/api/finoo_applications/intake', {
    method: 'POST',
    body,
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': '192.0.2.10',
      'finoo-message-id': messageId,
      'finoo-timestamp': timestamp,
      'finoo-signature': `v1,${computeFinooApplicationSignature(body, secret, messageId, timestamp)}`,
    },
  })
}

describe('FINOO intake route', () => {
  beforeEach(() => {
    process.env.OM_FINOO_APPLICATION_TENANT_ID = tenantId
    process.env.OM_FINOO_APPLICATION_ORGANIZATION_ID = organizationId
    createdRows.length = 0
    dispatch.mockReset().mockResolvedValue(true)
    findOne.mockReset().mockResolvedValue(null)
    integrationEnabled.mockReset().mockResolvedValue(true)
    encryptedFields.mockReset().mockResolvedValue(['payload_json'])
    encryptionEnabled.mockReset().mockReturnValue(true)
    getDek.mockReset().mockResolvedValue({ key: 'dek' })
    rateLimitConsume.mockReset().mockResolvedValue({ allowed: true, remainingPoints: 119, msBeforeNext: 60_000, consumedPoints: 1 })
  })

  it('durably accepts a sanitized row even when enqueue is unavailable', async () => {
    dispatch.mockResolvedValueOnce(false)
    const response = await POST(signedRequest({
      leadId: 'lead_12345678',
      completed: false,
      kontomatikToken: 'TOKEN_CANARY',
      unknownField: 'UNKNOWN_CANARY',
    }))
    expect(response.status).toBe(202)
    expect(createdRows).toHaveLength(1)
    const persisted = JSON.stringify(createdRows[0])
    expect(persisted).not.toContain('TOKEN_CANARY')
    expect(persisted).not.toContain('UNKNOWN_CANARY')
    expect(persisted).toContain('unknownField')
  })

  it('rejects an oversized body with 413 before integration or persistence', async () => {
    const response = await POST(new Request('http://localhost/api/finoo_applications/intake', {
      method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(65 * 1024) }, body: 'x',
    }))
    expect(response.status).toBe(413)
    expect(createdRows).toHaveLength(0)
    expect(integrationEnabled).not.toHaveBeenCalled()
  })

  it('accepts JSON parameters and rejects media-type prefix smuggling', async () => {
    const accepted = signedRequest({ leadId: 'lead_12345678', completed: false })
    accepted.headers.set('content-type', 'application/json; charset=utf-8')
    expect((await POST(accepted)).status).toBe(202)

    const rejected = signedRequest({ leadId: 'lead_12345678', completed: false })
    rejected.headers.set('content-type', 'application/jsonevil')
    expect((await POST(rejected)).status).toBe(415)
  })

  it('honors integration revocation before receipt persistence', async () => {
    integrationEnabled.mockResolvedValueOnce(false)
    const response = await POST(signedRequest({ leadId: 'lead_12345678', completed: false }))
    expect(response.status).toBe(503)
    expect(createdRows).toHaveLength(0)
  })

  it('distinguishes malformed request metadata from authentication failure', async () => {
    const malformedMetadata = await POST(signedRequest({ leadId: 'lead_12345678', completed: false }, 'short'))
    expect(malformedMetadata.status).toBe(400)

    const invalidSignatureRequest = signedRequest({ leadId: 'lead_12345678', completed: false })
    invalidSignatureRequest.headers.set('finoo-signature', `v1,${Buffer.alloc(32).toString('base64')}`)
    const invalidSignature = await POST(invalidSignatureRequest)
    expect(invalidSignature.status).toBe(401)
    expect(createdRows).toHaveLength(0)
  })

  it('fails closed when the rate limiter is disabled or unavailable', async () => {
    rateLimitConsume.mockResolvedValueOnce({ allowed: true, remainingPoints: 120, msBeforeNext: 0, consumedPoints: 0 })
    const response = await POST(signedRequest({ leadId: 'lead_12345678', completed: false }))
    expect(response.status).toBe(503)
    expect(createdRows).toHaveLength(0)
  })

  it('fails closed before rate limiting or persistence when no trusted source IP is available', async () => {
    const request = signedRequest({ leadId: 'lead_12345678', completed: false })
    request.headers.delete('x-forwarded-for')
    const response = await POST(request)
    expect(response.status).toBe(503)
    expect(rateLimitConsume).not.toHaveBeenCalled()
    expect(createdRows).toHaveLength(0)
  })

  it('fails closed when the trusted proxy value is not an IP address', async () => {
    const request = signedRequest({ leadId: 'lead_12345678', completed: false })
    request.headers.set('x-forwarded-for', 'attacker-controlled-bucket')
    const response = await POST(request)
    expect(response.status).toBe(503)
    expect(rateLimitConsume).not.toHaveBeenCalled()
    expect(createdRows).toHaveLength(0)
  })

  it('rejects an invalid trusted peer before reading a chunked body', async () => {
    let reads = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads += 1
        controller.enqueue(new TextEncoder().encode('{}'))
        controller.close()
      },
    }, { highWaterMark: 0 })
    const request = new Request('http://localhost/api/finoo_applications/intake', {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json', 'x-forwarded-for': 'not-an-ip' },
      duplex: 'half',
    } as RequestInit & { duplex: 'half' })
    const response = await POST(request)
    expect(response.status).toBe(503)
    expect(reads).toBe(0)
    expect(rateLimitConsume).not.toHaveBeenCalled()
  })

  it('fails closed before persistence when the intake encryption map is missing', async () => {
    encryptedFields.mockResolvedValueOnce([])
    const response = await POST(signedRequest({ leadId: 'lead_12345678', completed: false }))
    expect(response.status).toBe(503)
    expect(createdRows).toHaveLength(0)
  })

  it('fails closed before persistence when the tenant DEK is unavailable', async () => {
    getDek.mockResolvedValueOnce(null)
    const response = await POST(signedRequest({ leadId: 'lead_12345678', completed: false }))
    expect(response.status).toBe(503)
    expect(createdRows).toHaveLength(0)
  })

  it('returns duplicate only for the same digest and repairs delivery', async () => {
    const request = signedRequest({ leadId: 'lead_12345678', completed: false })
    const body = new Uint8Array(await request.clone().arrayBuffer())
    const digest = await crypto.subtle.digest('SHA-256', body)
    findOne.mockResolvedValueOnce({
      id: '123e4567-e89b-41d3-a456-426614174088',
      bodyDigest: Buffer.from(digest).toString('hex'),
      state: 'pending',
    })
    const response = await POST(request)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ duplicate: true })
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(createdRows).toHaveLength(0)
  })
})
