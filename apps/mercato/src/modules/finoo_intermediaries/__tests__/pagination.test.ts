import {
  decodeCursor,
  decodeNullableCursor,
  encodeCursor,
  encodeNullableCursor,
} from '../lib/pagination'

describe('finoo_intermediaries keyset cursors', () => {
  it('round-trips an opaque timestamp and UUID cursor', () => {
    const cursor = {
      timestamp: '2026-08-13T10:00:00.000Z',
      id: '11111111-1111-4111-8111-111111111111',
    }
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor)
  })

  it('rejects malformed cursors', () => {
    expect(decodeCursor('not-a-cursor')).toBeNull()
  })

  it('round-trips the null timestamp used after the dated activity partition', () => {
    const cursor = {
      timestamp: null,
      id: '11111111-1111-4111-8111-111111111111',
    }
    expect(decodeNullableCursor(encodeNullableCursor(cursor))).toEqual(cursor)
    expect(decodeCursor(encodeNullableCursor(cursor))).toBeNull()
  })
})
