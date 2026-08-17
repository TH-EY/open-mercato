import type { AuthContext } from '@open-mercato/shared/lib/auth/server'
import type { SearchEntityConfig } from '@open-mercato/shared/modules/search'

type SearchIndexerLike = {
  getEntityConfig: (entityId: string) => SearchEntityConfig | undefined
  getAllEntityConfigs: () => SearchEntityConfig[]
}

type RbacServiceLike = {
  userHasAllFeatures: (
    userId: string,
    features: string[],
    scope: { tenantId: string | null; organizationId: string | null },
  ) => Promise<boolean>
}

export async function resolveAuthorizedSearchEntityTypes(
  container: { resolve: <T = unknown>(name: string) => T },
  auth: NonNullable<AuthContext>,
  requestedEntityTypes?: string[],
  organizationId?: string | null,
): Promise<string[]> {
  let searchIndexer: SearchIndexerLike
  try {
    searchIndexer = container.resolve<SearchIndexerLike>('searchIndexer')
  } catch {
    return []
  }
  if (!searchIndexer) return []

  const requested = requestedEntityTypes
    ? [...new Set(requestedEntityTypes)].map((entityId) => searchIndexer.getEntityConfig(entityId))
    : searchIndexer.getAllEntityConfigs()
  const enabled = requested.filter((config): config is SearchEntityConfig => Boolean(config && config.enabled !== false))
  if (auth.isSuperAdmin === true) return enabled.map((config) => String(config.entityId))

  let rbacService: RbacServiceLike | null = null
  try {
    rbacService = container.resolve<RbacServiceLike>('rbacService')
  } catch {
    rbacService = null
  }
  const decisions = await Promise.all(enabled.map(async (config) => {
    const required = config.aclFeatures
    if (!required?.length) return String(config.entityId)
    if (!rbacService) return null
    try {
      const allowed = await rbacService.userHasAllFeatures(auth.sub, required, {
        tenantId: auth.tenantId,
        organizationId: organizationId ?? auth.orgId ?? null,
      })
      return allowed ? String(config.entityId) : null
    } catch {
      return null
    }
  }))

  return decisions.flatMap((entityId) => entityId ? [entityId] : [])
}
