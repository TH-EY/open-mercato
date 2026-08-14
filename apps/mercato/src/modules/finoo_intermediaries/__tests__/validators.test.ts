import {
  assignmentCreateSchema,
  noteBodySchema,
  partnerStatusUpdateSchema,
} from '../data/validators'

const uuid = '11111111-1111-4111-8111-111111111111'

describe('finoo_intermediaries validators', () => {
  it('accepts the bounded assignment input', () => {
    expect(assignmentCreateSchema.parse({
      dealId: uuid,
      intermediaryCustomerUserId: uuid,
    })).toEqual({
      dealId: uuid,
      intermediaryCustomerUserId: uuid,
    })
  })

  it('rejects unknown assignment fields', () => {
    expect(() => assignmentCreateSchema.parse({
      dealId: uuid,
      intermediaryCustomerUserId: uuid,
      eligibleStageId: uuid,
    })).toThrow()
  })

  it('trims and bounds note bodies', () => {
    expect(noteBodySchema.parse('  Partner note  ')).toBe('Partner note')
    expect(() => noteBodySchema.parse('   ')).toThrow()
    expect(() => noteBodySchema.parse('x'.repeat(10_001))).toThrow()
  })

  it('requires an optimistic-lock timestamp for status updates', () => {
    expect(partnerStatusUpdateSchema.parse({
      status: 'in_progress',
      expectedUpdatedAt: '2026-08-13T10:00:00.000Z',
    })).toEqual({
      status: 'in_progress',
      expectedUpdatedAt: '2026-08-13T10:00:00.000Z',
    })
    expect(() => partnerStatusUpdateSchema.parse({ status: 'done' })).toThrow()
  })
})
