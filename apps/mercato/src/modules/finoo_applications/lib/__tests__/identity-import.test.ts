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
})
