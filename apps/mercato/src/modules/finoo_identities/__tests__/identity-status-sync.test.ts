import type { IdentityFieldStatuses } from '../lib/identity-domain'
import {
  identityStatusStateKey,
  publishIdentityStatuses,
  readIdentityStatusSharedState,
} from '../widgets/injection/identity-status-sync'

describe('identity status widget synchronization', () => {
  it('publishes statuses under a Person-scoped key', () => {
    const set = jest.fn()
    const context = { sharedState: { set } }
    const statuses: IdentityFieldStatuses = {
      pesel: 'complete',
      documentType: 'complete',
      issuingCountryCode: 'complete',
      documentNumber: 'complete',
      issuedOn: 'complete',
      expiresOn: 'complete',
    }

    publishIdentityStatuses(context, 'person-1', statuses)

    expect(set).toHaveBeenCalledWith(identityStatusStateKey('person-1'), statuses)
    expect(readIdentityStatusSharedState(context)).toBe(context.sharedState)
  })

  it('ignores contexts without widget shared state', () => {
    expect(() => publishIdentityStatuses({}, 'person-1', {
      pesel: 'missing',
      documentType: 'missing',
      issuingCountryCode: 'missing',
      documentNumber: 'missing',
      issuedOn: 'missing',
      expiresOn: 'missing',
    })).not.toThrow()
  })
})
