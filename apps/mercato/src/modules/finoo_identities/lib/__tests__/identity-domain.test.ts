import { computeIdentityCompleteness, validatePesel } from '../identity-domain'

describe('FINOO identity domain', () => {
  it('accepts a PESEL with a valid checksum and encoded birth date', () => {
    expect(validatePesel('44051401458')).toEqual({
      valid: true,
      normalized: '44051401458',
    })
  })

  it('marks an identity complete only when every applicable field is valid', () => {
    expect(computeIdentityCompleteness({
      pesel: '44051401458',
      documentType: 'identity_card',
      issuingCountryCode: 'PL',
      documentNumber: 'ABC 123456',
      issuedOn: '2024-05-14',
      expiresOn: '2034-05-14',
    })).toEqual({
      isComplete: true,
      statuses: {
        pesel: 'complete',
        documentType: 'complete',
        issuingCountryCode: 'complete',
        documentNumber: 'complete',
        issuedOn: 'complete',
        expiresOn: 'complete',
      },
    })
  })

  it('treats expiry as not applicable for a permanent identity card', () => {
    expect(computeIdentityCompleteness({
      pesel: '44051401458',
      documentType: 'permanent_identity_card',
      issuingCountryCode: 'PL',
      documentNumber: 'ABC 123456',
      issuedOn: '2000-01-01',
      expiresOn: null,
    })).toMatchObject({
      isComplete: true,
      statuses: { expiresOn: 'not_applicable' },
    })
  })

  it('reports invalid legacy PESEL and impossible dates as missing', () => {
    expect(validatePesel('44023101458')).toMatchObject({ valid: false, reason: 'invalid' })
    expect(computeIdentityCompleteness({
      pesel: '44023101458',
      documentType: 'passport',
      issuingCountryCode: 'PL',
      documentNumber: 'AA1234567',
      issuedOn: '2024-02-31',
      expiresOn: '2024-02-01',
    })).toMatchObject({
      isComplete: false,
      statuses: { pesel: 'missing', issuedOn: 'missing', expiresOn: 'complete' },
    })
  })
})
