import { FINOO_APPLICATION_MAX_BODY_BYTES } from './signature'

export class FinooApplicationBodyTooLargeError extends Error {}
export class FinooApplicationInvalidUtf8Error extends Error {}

export function hasOversizedFinooApplicationContentLength(request: Request): boolean {
  const declared = request.headers.get('content-length')?.trim()
  return Boolean(declared && /^\d+$/.test(declared) && Number(declared) > FINOO_APPLICATION_MAX_BODY_BYTES)
}

export async function readFinooApplicationBody(request: Request): Promise<Uint8Array> {
  if (hasOversizedFinooApplicationContentLength(request)) {
    throw new FinooApplicationBodyTooLargeError()
  }
  if (!request.body) return new Uint8Array()
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > FINOO_APPLICATION_MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new FinooApplicationBodyTooLargeError()
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

export function decodeFinooApplicationBody(body: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body)
  } catch {
    throw new FinooApplicationInvalidUtf8Error()
  }
}
