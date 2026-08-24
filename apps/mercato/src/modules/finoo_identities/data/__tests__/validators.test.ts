import { finooIdentityInputSchema } from '../validators'

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
})
