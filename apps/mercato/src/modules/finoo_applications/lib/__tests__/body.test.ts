import { FinooApplicationBodyTooLargeError, FinooApplicationInvalidUtf8Error, decodeFinooApplicationBody, readFinooApplicationBody } from '../body'
import { FINOO_APPLICATION_MAX_BODY_BYTES } from '../signature'

describe('FINOO bounded exact-byte body', () => {
  it('preserves valid raw bytes', async () => {
    const expected = new TextEncoder().encode('{"leadId":"lead_12345678"}')
    const actual = await readFinooApplicationBody(new Request('http://localhost', { method: 'POST', body: expected }))
    expect(actual).toEqual(expected)
    expect(decodeFinooApplicationBody(actual)).toBe('{"leadId":"lead_12345678"}')
  })

  it('rejects declared and streamed bodies over 64 KiB', async () => {
    await expect(readFinooApplicationBody(new Request('http://localhost', {
      method: 'POST', headers: { 'content-length': String(FINOO_APPLICATION_MAX_BODY_BYTES + 1) }, body: 'x',
    }))).rejects.toBeInstanceOf(FinooApplicationBodyTooLargeError)
    await expect(readFinooApplicationBody(new Request('http://localhost', {
      method: 'POST', body: new Uint8Array(FINOO_APPLICATION_MAX_BODY_BYTES + 1),
    }))).rejects.toBeInstanceOf(FinooApplicationBodyTooLargeError)
  })

  it('rejects malformed UTF-8 after byte authentication', () => {
    expect(() => decodeFinooApplicationBody(new Uint8Array([0xc3, 0x28]))).toThrow(FinooApplicationInvalidUtf8Error)
  })
})
