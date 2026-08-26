import type { SanitizedFinooApplicationPayload } from '../../data/validators'
import { buildFinooIdentityImportInput } from '../identity-import'

describe('FINOO application identity import mapping', () => {
  it('maps one current passport without exposing dictionary identifiers', () => {
    const payload = {
      pesel: '44051401458',
      idType: 'PASSPORT',
      passport: 'AB1234567',
      passportCountryCode: 'de',
      passportIssued: '2024-01-10',
      passportExpiry: '2034-01-10',
    } as SanitizedFinooApplicationPayload

    expect(buildFinooIdentityImportInput(payload)).toEqual({
      pesel: '44051401458',
      documentType: 'passport',
      issuingCountryCode: 'DE',
      documentNumber: 'AB1234567',
      issuedOn: '2024-01-10',
      expiresOn: '2034-01-10',
    })
  })

  it.each([
    ['IDCARD', 'idCard', 'identity_card'],
    ['DIGITCARD', 'digitCard', 'digital_identity_card'],
  ] as const)('derives Poland for %s when the form omits country', (idType, documentField, documentType) => {
    const payload = {
      pesel: '44051401458',
      idType,
      [documentField]: 'ABC123456',
    } as SanitizedFinooApplicationPayload

    expect(buildFinooIdentityImportInput(payload)).toMatchObject({
      documentType,
      issuingCountryCode: 'PL',
    })
  })

  it('does not derive a country for a passport', () => {
    const payload = {
      pesel: '44051401458',
      idType: 'PASSPORT',
      passport: 'AB1234567',
    } as SanitizedFinooApplicationPayload

    expect(buildFinooIdentityImportInput(payload)).toMatchObject({
      documentType: 'passport',
      issuingCountryCode: null,
    })
  })
})
