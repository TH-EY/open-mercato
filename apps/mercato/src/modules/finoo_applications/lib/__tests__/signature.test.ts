import { parseAndSanitizeFinooApplicationPayload } from '../../data/validators'
import {
  computeFinooApplicationSignature,
  FINOO_APPLICATION_MAX_BODY_BYTES,
  verifyFinooApplicationSignature,
} from '../signature'

const encoder = new TextEncoder()
const secret = 'a'.repeat(48)
const messageId = 'nonce_1234567890123456'
const timestamp = '1787083200'
const nowSeconds = Number(timestamp)

function signedHeaders(body: Uint8Array): Headers {
  return new Headers({
    'finoo-message-id': messageId,
    'finoo-timestamp': timestamp,
    'finoo-signature': `v1,${computeFinooApplicationSignature(body, secret, messageId, timestamp)}`,
  })
}

describe('FINOO application ingress contract', () => {
  it('authenticates exact bytes and rejects body changes', () => {
    const body = encoder.encode(JSON.stringify({ leadId: 'lead_12345678' }))
    expect(verifyFinooApplicationSignature(body, signedHeaders(body), secret, nowSeconds)).toEqual({ ok: true, messageId, sourceTimestamp: nowSeconds })
    expect(verifyFinooApplicationSignature(encoder.encode(`${new TextDecoder().decode(body)} `), signedHeaders(body), secret, nowSeconds)).toEqual({ ok: false, reason: 'invalid_signature' })
  })

  it('rejects stale, malformed, short-secret, and oversized inputs', () => {
    const body = encoder.encode(JSON.stringify({ leadId: 'lead_12345678' }))
    expect(verifyFinooApplicationSignature(body, new Headers(), secret, nowSeconds)).toEqual({ ok: false, reason: 'invalid_request' })
    const malformed = signedHeaders(body)
    malformed.set('finoo-signature', 'v1,not-base64!')
    expect(verifyFinooApplicationSignature(body, malformed, secret, nowSeconds)).toEqual({ ok: false, reason: 'invalid_signature' })
    expect(verifyFinooApplicationSignature(body, signedHeaders(body), 'short', nowSeconds)).toEqual({ ok: false, reason: 'invalid_signature' })
    expect(verifyFinooApplicationSignature(body, signedHeaders(body), secret, nowSeconds + 301)).toEqual({ ok: false, reason: 'invalid_request' })
    const oversized = new Uint8Array(FINOO_APPLICATION_MAX_BODY_BYTES + 1)
    expect(verifyFinooApplicationSignature(oversized, signedHeaders(oversized), secret, nowSeconds)).toEqual({ ok: false, reason: 'invalid_signature' })
  })

  it('strips token, unknown values, and unsafe unknown key names', () => {
    const tokenCanary = 'KONTOMATIK_SECRET_CANARY_123'
    const sanitized = parseAndSanitizeFinooApplicationPayload({
      leadId: 'lead_12345678', kontomatikCompleted: '1', kontomatikToken: tokenCanary,
      unexpectedField: 'must-not-survive', 'SECRET_VALUE_AS_A_KEY!': 'must-not-survive-either',
    }, { messageId, sourceTimestamp: nowSeconds })
    expect(sanitized).not.toHaveProperty('kontomatikToken')
    expect(sanitized).not.toHaveProperty('unexpectedField')
    expect(JSON.stringify(sanitized)).not.toContain(tokenCanary)
    expect(JSON.stringify(sanitized)).not.toContain('must-not-survive')
    expect(sanitized.ingestionMeta.unknownFieldNames).toEqual(['unexpectedField'])
  })

  it('rejects numeric lead IDs and incomplete finals', () => {
    expect(() => parseAndSanitizeFinooApplicationPayload({ leadId: 9007199254740992 }, { messageId, sourceTimestamp: nowSeconds })).toThrow()
    expect(() => parseAndSanitizeFinooApplicationPayload({ leadId: 'lead_12345678', completed: true }, { messageId, sourceTimestamp: nowSeconds })).toThrow()
  })
})
