import { resolveAuthorizedSearchEntityTypes } from '../authorized-entity-types'

const finooConfig = {
  entityId: 'finoo_intermediaries:finoo_intermediary',
  enabled: true,
  aclFeatures: ['finoo_intermediaries.view'],
}

function containerFor(configs: Array<Record<string, unknown>>) {
  return {
    resolve: () => ({
      getEntityConfig: (entityId: string) => configs.find((config) => config.entityId === entityId),
      getAllEntityConfigs: () => configs,
    }),
  }
}

describe('search API per-entity authorization', () => {
  it('denies a caller with search.view but without the entity view feature', () => {
    const authorized = resolveAuthorizedSearchEntityTypes(
      containerFor([finooConfig]) as never,
      {
        sub: 'user-1',
        tenantId: 'tenant-1',
        orgId: 'org-1',
        features: ['search.view'],
      },
      ['finoo_intermediaries:finoo_intermediary'],
    )
    expect(authorized).toEqual([])
  })

  it('allows the scoped entity only when its declared feature is granted', () => {
    const authorized = resolveAuthorizedSearchEntityTypes(
      containerFor([finooConfig]) as never,
      {
        sub: 'user-1',
        tenantId: 'tenant-1',
        orgId: 'org-1',
        features: ['search.view', 'finoo_intermediaries.view'],
      },
      ['finoo_intermediaries:finoo_intermediary'],
    )
    expect(authorized).toEqual(['finoo_intermediaries:finoo_intermediary'])
  })

  it('fails closed for regular users when an entity omits aclFeatures', () => {
    const authorized = resolveAuthorizedSearchEntityTypes(
      containerFor([{ entityId: 'legacy:item', enabled: true }]) as never,
      {
        sub: 'user-1',
        tenantId: 'tenant-1',
        orgId: 'org-1',
        features: ['search.view'],
      },
    )
    expect(authorized).toEqual([])
  })
})
