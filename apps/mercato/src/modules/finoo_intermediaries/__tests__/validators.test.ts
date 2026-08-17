import {
  assignmentCreateSchema,
  intermediaryInviteSchema,
  intermediaryLifecycleActionSchema,
  intermediaryUpdateSchema,
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

  it('normalizes and validates the complete intermediary identity', () => {
    expect(intermediaryInviteSchema.parse({
      email: '  Patryk.Madaj@THEY.DEV ',
      firstName: ' Patryk ',
      lastName: ' Madaj ',
    })).toEqual({
      email: 'patryk.madaj@they.dev',
      firstName: 'Patryk',
      lastName: 'Madaj',
    })
    expect(() => intermediaryInviteSchema.parse({
      email: 'invalid',
      firstName: 'Patryk',
      lastName: 'Madaj',
    })).toThrow()
    expect(() => intermediaryInviteSchema.parse({
      email: 'patryk.madaj@they.dev',
      firstName: ' ',
      lastName: 'Madaj',
    })).toThrow()
  })

  it('keeps email optional on edit and requires optimistic locking for every lifecycle action', () => {
    expect(intermediaryUpdateSchema.parse({
      firstName: 'Patryk',
      lastName: 'Madaj',
      expectedUpdatedAt: '2026-08-17T10:00:00.000Z',
    })).toEqual({
      firstName: 'Patryk',
      lastName: 'Madaj',
      expectedUpdatedAt: '2026-08-17T10:00:00.000Z',
    })
    expect(intermediaryLifecycleActionSchema.parse({
      expectedUpdatedAt: '2026-08-17T10:00:00.000Z',
    })).toEqual({ expectedUpdatedAt: '2026-08-17T10:00:00.000Z' })
    expect(() => intermediaryLifecycleActionSchema.parse({})).toThrow()
  })
})
