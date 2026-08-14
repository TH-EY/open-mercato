import type { EntityManager } from '@mikro-orm/postgresql'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { loadAffiliateRole } from '../../lib/membership'
import invitedHandler, { metadata as invitedMetadata } from '../customer-user-invited'
import acceptedHandler, { metadata as acceptedMetadata } from '../customer-invitation-accepted'

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({ findOneWithDecryption: jest.fn() }))
jest.mock('../../lib/membership', () => ({ loadAffiliateRole: jest.fn() }))

const findOne = jest.mocked(findOneWithDecryption)
const loadRole = jest.mocked(loadAffiliateRole)

function context(execute: jest.Mock) {
  const em = { fork: () => em } as unknown as EntityManager
  const container = {
    resolve: (name: string) => name === 'em' ? em : { execute },
  }
  return container
}

describe('Finoo customer invitation subscribers', () => {
  beforeEach(() => jest.clearAllMocks())

  it('is explicitly nonpersistent and ignores untrusted payloads', async () => {
    const execute = jest.fn()
    expect(invitedMetadata.persistent).toBe(false)
    expect(acceptedMetadata.persistent).toBe(false)
    await invitedHandler({}, context(execute))
    await acceptedHandler({ invitationId: 'id' }, context(execute))
    expect(findOne).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })

  it('ignores a persisted invitation without the tenant affiliate role', async () => {
    const execute = jest.fn()
    findOne.mockResolvedValue({ id: 'invitation', tenantId: 'tenant', organizationId: 'organization', roleIdsJson: ['other'] })
    loadRole.mockResolvedValue({ id: 'affiliate-role' })
    await invitedHandler({ invitationId: 'invitation' }, context(execute))
    expect(execute).not.toHaveBeenCalled()
  })

  it('uses persisted scope instead of event scope for an affiliate invitation', async () => {
    const execute = jest.fn().mockResolvedValue({})
    findOne.mockResolvedValue({ id: 'persisted', tenantId: 'tenant', organizationId: 'organization', roleIdsJson: ['affiliate-role'] })
    loadRole.mockResolvedValue({ id: 'affiliate-role' })
    await invitedHandler({ invitationId: 'persisted', tenantId: 'evil' }, context(execute))
    expect(execute).toHaveBeenCalledWith(
      'finoo_affiliates.affiliate.ensure_invitation',
      expect.objectContaining({ input: { invitationId: 'persisted', tenantId: 'tenant', organizationId: 'organization' } }),
    )
  })
})
