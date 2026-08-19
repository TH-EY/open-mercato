import { createHmac, timingSafeEqual } from 'node:crypto'

export const FINOO_APPLICATION_MAX_BODY_BYTES = 64 * 1024
export const FINOO_APPLICATION_SIGNATURE_HEADER = 'finoo-signature'
export const FINOO_APPLICATION_MESSAGE_ID_HEADER = 'finoo-message-id'
export const FINOO_APPLICATION_TIMESTAMP_HEADER = 'finoo-timestamp'
export const FINOO_APPLICATION_REPLAY_WINDOW_SECONDS = 5 * 60

export type FinooApplicationSignatureResult =
  | { ok: true; messageId: string; sourceTimestamp: number }
  | { ok: false; reason: 'invalid_request' | 'invalid_signature' }

const MESSAGE_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/
const TIMESTAMP_PATTERN = /^\d{10}$/
const CANONICAL_BASE64_PATTERN = /^[A-Za-z0-9+/]{43}=$/

function signatureCandidates(header: string): Buffer[] {
  return header.split(/\s+/).flatMap((token) => {
    const separator = token.indexOf(',')
    if (separator < 0 || token.slice(0, separator) !== 'v1') return []
    const encoded = token.slice(separator + 1)
    if (!CANONICAL_BASE64_PATTERN.test(encoded)) return []
    const decoded = Buffer.from(encoded, 'base64')
    return decoded.length === 32 && decoded.toString('base64') === encoded ? [decoded] : []
  })
}

export function computeFinooApplicationSignature(
  body: Uint8Array,
  secret: string,
  messageId: string,
  timestamp: string,
): string {
  return createHmac('sha256', secret)
    .update(`${messageId}.${timestamp}.`, 'ascii')
    .update(body)
    .digest('base64')
}

export function verifyFinooApplicationSignature(
  body: Uint8Array,
  headers: Headers,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): FinooApplicationSignatureResult {
  if (body.byteLength > FINOO_APPLICATION_MAX_BODY_BYTES || Buffer.byteLength(secret, 'utf8') < 32) {
    return { ok: false, reason: 'invalid_signature' }
  }
  const messageId = headers.get(FINOO_APPLICATION_MESSAGE_ID_HEADER)?.trim() ?? ''
  const timestamp = headers.get(FINOO_APPLICATION_TIMESTAMP_HEADER)?.trim() ?? ''
  const signature = headers.get(FINOO_APPLICATION_SIGNATURE_HEADER)?.trim() ?? ''
  if (!MESSAGE_ID_PATTERN.test(messageId) || !TIMESTAMP_PATTERN.test(timestamp)) {
    return { ok: false, reason: 'invalid_request' }
  }
  if (!signature) return { ok: false, reason: 'invalid_signature' }
  const sourceTimestamp = Number(timestamp)
  if (!Number.isSafeInteger(sourceTimestamp) || Math.abs(nowSeconds - sourceTimestamp) > FINOO_APPLICATION_REPLAY_WINDOW_SECONDS) {
    return { ok: false, reason: 'invalid_request' }
  }
  const expected = Buffer.from(computeFinooApplicationSignature(body, secret, messageId, timestamp), 'base64')
  const valid = signatureCandidates(signature).some((provided) => timingSafeEqual(provided, expected))
  return valid
    ? { ok: true, messageId, sourceTimestamp }
    : { ok: false, reason: 'invalid_signature' }
}
