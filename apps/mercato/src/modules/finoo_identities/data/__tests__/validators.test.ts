import { finooIdentityFormSchema, finooIdentityInputSchema } from '../validators'

describe('FINOO identity input', () => {
  it('normalizes a valid PESEL and country code', () => {
    expect(finooIdentityInputSchema.parse({
      pesel: '44051401458',
      issuingCountryCode: 'pl',
    })).toMatchObject({ pesel: '44051401458', issuingCountryCode: 'PL' })
  })

  it('rejects an invalid PESEL and reversed document dates', () => {
    const result = finooIdentityInputSchema.safeParse({
      pesel: '12345678901',
      issuedOn: '2025-01-01',
      expiresOn: '2024-01-01',
    })
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.issues.map((issue) => issue.message)).toEqual(expect.arrayContaining([
      'invalid_pesel',
      'expiry_before_issue_date',
    ]))
  })

  it.each(['identity_card', 'permanent_identity_card', 'digital_identity_card'])(
    'derives Poland for %s when the country is omitted',
    (documentType) => {
      expect(finooIdentityInputSchema.parse({
        pesel: '44051401458',
        documentType,
        issuingCountryCode: null,
      })).toMatchObject({ issuingCountryCode: 'PL' })
    },
  )

  it('rejects an explicit foreign country for a Polish identity document', () => {
    const result = finooIdentityInputSchema.safeParse({
      pesel: '44051401458',
      documentType: 'identity_card',
      issuingCountryCode: 'DE',
    })
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ['issuingCountryCode'], message: 'invalid_issuing_country_for_document_type' }),
    ]))
  })

  it('keeps issuing country mandatory only for passport completeness, not input acceptance', () => {
    expect(finooIdentityInputSchema.parse({
      pesel: '44051401458',
      documentType: 'passport',
      issuingCountryCode: null,
    })).toMatchObject({ issuingCountryCode: null })
  })

  it('clears a stale passport country when the form switches to a Polish identity document', () => {
    expect(finooIdentityFormSchema.parse({
      pesel: '44051401458',
      documentType: 'identity_card',
      issuingCountryCode: 'DE',
    })).toMatchObject({ issuingCountryCode: 'PL' })
  })
})
