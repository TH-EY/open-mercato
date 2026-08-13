import { resolveAffiliateName, splitAffiliateDisplayName } from '../affiliateNames'

describe('affiliate names', () => {
  it('splits and normalizes a display name', () => {
    expect(splitAffiliateDisplayName('  Anna   Maria Kowalska ')).toEqual({ firstName: 'Anna Maria', lastName: 'Kowalska' })
    expect(splitAffiliateDisplayName('Anna')).toEqual({ firstName: 'Anna', lastName: '' })
  })

  it('prefers person fields independently and falls back to display name', () => {
    expect(resolveAffiliateName('Anna Kowalska', { firstName: ' Joanna ', lastName: null })).toEqual({
      firstName: 'Joanna',
      lastName: 'Kowalska',
    })
  })
})
