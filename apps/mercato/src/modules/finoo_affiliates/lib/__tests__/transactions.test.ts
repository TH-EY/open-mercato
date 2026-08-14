import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { resolveTransactionTarget } from '../transactions'

describe('Finoo affiliate transaction lifecycle', () => {
  it.each([
    ['processing', 'accept', 'approved'],
    ['processing', 'reject', 'rejected'],
    ['rejected', 'reprocess', 'processing'],
  ] as const)('allows %s -> %s', (current, action, expected) => {
    expect(resolveTransactionTarget(current, action)).toBe(expected)
  })

  it.each([
    ['approved', 'accept'],
    ['approved', 'reject'],
    ['rejected', 'accept'],
    ['paid_out', 'reprocess'],
  ] as const)('rejects %s -> %s', (current, action) => {
    expect(() => resolveTransactionTarget(current, action)).toThrow(CrudHttpError)
    try {
      resolveTransactionTarget(current, action)
    } catch (error) {
      expect(error).toMatchObject({ status: 409, body: { code: 'INVALID_COMMISSION_TRANSITION' } })
    }
  })
})
