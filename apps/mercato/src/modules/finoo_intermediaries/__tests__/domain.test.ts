import { defaultEncryptionMaps } from '../encryption'
import {
  isExactEligiblePipelineName,
  isExactEligibleStageLabel,
  isLegalPartnerStatusTransition,
  scopedActiveAssignmentWhere,
} from '../lib/domain'

describe('finoo_intermediaries domain contracts', () => {
  it('matches only the complete normalized eligible stage label', () => {
    expect(isExactEligibleStageLabel(' Sent To Partners ')).toBe(true)
    expect(isExactEligibleStageLabel('sent to partners')).toBe(true)
    expect(isExactEligibleStageLabel('Sent To Partner')).toBe(false)
    expect(isExactEligibleStageLabel('Sent To Intermediaries')).toBe(false)
    expect(isExactEligibleStageLabel('Partners')).toBe(false)
  })

  it('matches only the complete normalized eligible pipeline name', () => {
    expect(isExactEligiblePipelineName(' Web Form Sales Pipeline ')).toBe(true)
    expect(isExactEligiblePipelineName('Web Sales Pipeline')).toBe(false)
  })

  it('allows only forward adjacent partner-status transitions', () => {
    expect(isLegalPartnerStatusTransition('new', 'in_progress')).toBe(true)
    expect(isLegalPartnerStatusTransition('in_progress', 'done')).toBe(true)
    expect(isLegalPartnerStatusTransition('new', 'done')).toBe(false)
    expect(isLegalPartnerStatusTransition('done', 'in_progress')).toBe(false)
    expect(isLegalPartnerStatusTransition('new', 'new')).toBe(false)
  })

  it('always scopes active assignment lookups by tenant and organization', () => {
    expect(scopedActiveAssignmentWhere({
      tenantId: '11111111-1111-4111-8111-111111111111',
      organizationId: '22222222-2222-4222-8222-222222222222',
      dealId: '33333333-3333-4333-8333-333333333333',
    })).toEqual({
      tenantId: '11111111-1111-4111-8111-111111111111',
      organizationId: '22222222-2222-4222-8222-222222222222',
      dealId: '33333333-3333-4333-8333-333333333333',
      deletedAt: null,
    })
  })

  it('encrypts note bodies without adding an equality hash', () => {
    expect(defaultEncryptionMaps).toEqual([
      {
        entityId: 'finoo_intermediaries:finoo_intermediary_note',
        fields: [{ field: 'body' }],
      },
    ])
  })
})
