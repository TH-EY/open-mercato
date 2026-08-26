import { ensureFinooCustomerRetentionCustomFieldDefinitions } from '../lib/custom-field-definitions'

const tenantId = '11111111-1111-4111-8111-111111111111'
const entityId = 'customers:customer_person_profile'

describe('Finoo customer retention custom-field definitions', () => {
  it('adds the excluded label to an existing tenant definition and verifies the readback', async () => {
    const definitions = [
      {
        entityId,
        tenantId,
        organizationId: null,
        key: 'finoo_retention_status',
        kind: 'select',
        configJson: {
          label: 'Retention status',
          options: [
            { value: 'active', label: 'Active' },
            { value: 'expired', label: 'Expired' },
          ],
          filterable: true,
          indexed: true,
          listVisible: true,
          formEditable: false,
          priority: 0,
        },
        isActive: true,
        deletedAt: null,
      },
      {
        entityId,
        tenantId,
        organizationId: null,
        key: 'finoo_retention_expires_at',
        kind: 'datetime',
        configJson: {
          label: 'Retention expiry',
          filterable: true,
          indexed: true,
          listVisible: true,
          formEditable: false,
          priority: 1,
        },
        isActive: true,
        deletedAt: null,
      },
    ]
    const em = {
      find: jest.fn(async () => definitions),
      persist: jest.fn(),
      flush: jest.fn(async () => undefined),
    }
    const cache = { deleteByTags: jest.fn(async () => undefined) }

    await expect(ensureFinooCustomerRetentionCustomFieldDefinitions({
      em: em as never,
      cache: cache as never,
      tenantId,
    })).resolves.toEqual({
      created: 0,
      updated: 1,
      unchanged: 1,
      verified: 2,
    })

    expect(definitions[0]!.configJson.options).toEqual([
      { value: 'active', label: 'Active' },
      { value: 'expired', label: 'Expired' },
      { value: 'excluded', label: 'Not applicable' },
    ])
    expect(em.flush).toHaveBeenCalledTimes(1)
    expect(cache.deleteByTags).toHaveBeenCalled()

    await expect(ensureFinooCustomerRetentionCustomFieldDefinitions({
      em: em as never,
      cache: cache as never,
      tenantId,
    })).resolves.toEqual({
      created: 0,
      updated: 0,
      unchanged: 2,
      verified: 2,
    })
    expect(em.flush).toHaveBeenCalledTimes(1)
    expect(cache.deleteByTags).toHaveBeenCalledTimes(1)
  })
})
