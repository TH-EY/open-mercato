import type { CrudCtx } from '@open-mercato/shared/lib/crud/factory'

const findWithDecryptionMock = jest.fn()

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findWithDecryption: (...args: unknown[]) => findWithDecryptionMock(...args),
}))

import { buildProductFilters } from '../route'

describe('catalog product list filters', () => {
  beforeEach(() => {
    findWithDecryptionMock.mockReset()
  })

  it('does not constrain search prequeries to a null organization in all-organizations scope', async () => {
    const em = {}
    findWithDecryptionMock.mockResolvedValue([{ id: 'product-1' }])
    const ctx = {
      auth: {
        sub: 'user-1',
        tenantId: 'tenant-1',
        orgId: null,
      },
      container: {
        resolve: (name: string) => {
          if (name === 'em') return { fork: () => em }
          return null
        },
      },
      selectedOrganizationId: null,
      organizationIds: null,
    } as unknown as CrudCtx

    const filters = await buildProductFilters(
      { page: 1, pageSize: 50, search: 'test 123456' },
      ctx,
    )

    expect(filters).toMatchObject({ id: { $eq: 'product-1' } })
    expect(findWithDecryptionMock).toHaveBeenCalledTimes(1)
    const where = findWithDecryptionMock.mock.calls[0][2] as Record<string, unknown>
    expect(where).toMatchObject({ tenantId: 'tenant-1' })
    expect(where).not.toHaveProperty('organizationId')
  })

  it.each([
    {
      label: 'selected organization',
      selectedOrganizationId: 'organization-1',
      organizationIds: null,
      expectedOrganization: 'organization-1',
    },
    {
      label: 'allowed organizations',
      selectedOrganizationId: null,
      organizationIds: ['organization-1', 'organization-2'],
      expectedOrganization: { $in: ['organization-1', 'organization-2'] },
    },
  ])('preserves the $label restriction in search prequeries', async ({
    selectedOrganizationId,
    organizationIds,
    expectedOrganization,
  }) => {
    findWithDecryptionMock.mockResolvedValue([{ id: 'product-1' }])
    const ctx = {
      auth: {
        sub: 'user-1',
        tenantId: 'tenant-1',
        orgId: null,
      },
      container: {
        resolve: (name: string) => {
          if (name === 'em') return { fork: () => ({}) }
          return null
        },
      },
      selectedOrganizationId,
      organizationIds,
    } as unknown as CrudCtx

    await buildProductFilters(
      { page: 1, pageSize: 50, search: 'test 123456' },
      ctx,
    )

    const where = findWithDecryptionMock.mock.calls[0][2] as Record<string, unknown>
    expect(where).toMatchObject({
      tenantId: 'tenant-1',
      organizationId: expectedOrganization,
    })
  })
})
