import { resolveAuthorizedSearchEntityTypes } from '../authorized-entity-types'

const finooConfig = {
  entityId: 'finoo_intermediaries:finoo_intermediary',
  enabled: true,
  aclFeatures: ['finoo_intermediaries.view'],
}

function containerFor(
  configs: Array<Record<string, unknown>>,
  userHasAllFeatures = jest.fn().mockResolvedValue(false),
) {
  return {
    resolve: (name: string) => {
      if (name === 'searchIndexer') {
        return {
          getEntityConfig: (entityId: string) => configs.find((config) => config.entityId === entityId),
          getAllEntityConfigs: () => configs,
        }
      }
      if (name === 'rbacService') return { userHasAllFeatures }
      throw new Error(`Unexpected dependency: ${name}`)
    },
  }
}

describe('search API per-entity authorization', () => {
  it('denies a production-shaped caller when live RBAC rejects the declared entity feature', async () => {
    const userHasAllFeatures = jest.fn().mockResolvedValue(false)
    const authorized = await resolveAuthorizedSearchEntityTypes(
      containerFor([finooConfig], userHasAllFeatures) as never,
      {
        sub: 'user-1',
        tenantId: 'tenant-1',
        orgId: 'org-1',
        roles: ['employee'],
      },
      ['finoo_intermediaries:finoo_intermediary'],
      'org-1',
    )
    expect(authorized).toEqual([])
    expect(userHasAllFeatures).toHaveBeenCalledWith(
      'user-1',
      ['finoo_intermediaries.view'],
      { tenantId: 'tenant-1', organizationId: 'org-1' },
    )
  })

  it('allows a production-shaped API key only when canonical live RBAC grants the feature', async () => {
    const userHasAllFeatures = jest.fn().mockResolvedValue(true)
    const authorized = await resolveAuthorizedSearchEntityTypes(
      containerFor([finooConfig], userHasAllFeatures) as never,
      {
        sub: 'api_key:key-1',
        tenantId: 'tenant-1',
        orgId: 'org-1',
        isApiKey: true,
        userId: 'user-1',
      },
      ['finoo_intermediaries:finoo_intermediary'],
      'org-1',
    )
    expect(authorized).toEqual(['finoo_intermediaries:finoo_intermediary'])
    expect(userHasAllFeatures).toHaveBeenCalledWith(
      'api_key:key-1',
      ['finoo_intermediaries.view'],
      { tenantId: 'tenant-1', organizationId: 'org-1' },
    )
  })

  it('does not elevate a mutable role named superadmin', async () => {
    const userHasAllFeatures = jest.fn().mockResolvedValue(false)
    const authorized = await resolveAuthorizedSearchEntityTypes(
      containerFor([finooConfig], userHasAllFeatures) as never,
      {
        sub: 'user-1',
        tenantId: 'tenant-1',
        orgId: 'org-1',
        roles: ['superadmin'],
        isSuperAdmin: false,
      },
      ['finoo_intermediaries:finoo_intermediary'],
    )
    expect(authorized).toEqual([])
    expect(userHasAllFeatures).toHaveBeenCalledTimes(1)
  })

  it('preserves legacy HTTP search behavior when an entity omits aclFeatures', async () => {
    const userHasAllFeatures = jest.fn().mockResolvedValue(false)
    const authorized = await resolveAuthorizedSearchEntityTypes(
      containerFor([{ entityId: 'legacy:item', enabled: true }], userHasAllFeatures) as never,
      {
        sub: 'user-1',
        tenantId: 'tenant-1',
        orgId: 'org-1',
      },
    )
    expect(authorized).toEqual(['legacy:item'])
    expect(userHasAllFeatures).not.toHaveBeenCalled()
  })
})
