import type { AuthContext } from '@open-mercato/shared/lib/auth/server'
import { authorizeFeatures } from '@open-mercato/shared/security/featurePolicy'
import type { SearchEntityConfig } from '@open-mercato/shared/modules/search'

type SearchIndexerLike = {
  getEntityConfig: (entityId: string) => SearchEntityConfig | undefined
  getAllEntityConfigs: () => SearchEntityConfig[]
}

export function resolveAuthorizedSearchEntityTypes(
  container: { resolve: <T = unknown>(name: string) => T },
  auth: NonNullable<AuthContext>,
  requestedEntityTypes?: string[],
): string[] {
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
  const grantedFeatures = Array.isArray(auth.features)
    ? auth.features.filter((value): value is string => typeof value === 'string')
    : []
  const unrestricted = auth.roles?.includes('superadmin') || auth.isSuperAdmin === true

  return requested.flatMap((config) => {
    if (!config || config.enabled === false) return []
    if (unrestricted) return [String(config.entityId)]
    const required = config.aclFeatures
    if (!required?.length) return []
    return authorizeFeatures(required, { grantedFeatures }) ? [String(config.entityId)] : []
  })
}
