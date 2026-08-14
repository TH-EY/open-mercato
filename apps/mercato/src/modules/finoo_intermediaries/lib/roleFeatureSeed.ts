import { LockMode, type EntityManager } from '@mikro-orm/postgresql'
import {
  CustomerRole,
  CustomerRoleAcl,
} from '@open-mercato/core/modules/customer_accounts/data/entities'
import type { CustomerRbacService } from '@open-mercato/core/modules/customer_accounts/services/customerRbacService'

export const INTERMEDIARY_ROLE_SLUG = 'intermediary'
export const INTERMEDIARY_PORTAL_FEATURE = 'portal.finoo_intermediaries.view'

export type IntermediaryRoleFeatureScope = {
  tenantId: string
  organizationId: string
}

export type IntermediaryRoleFeatureResult = {
  changed: boolean
  roleId: string
  feature: typeof INTERMEDIARY_PORTAL_FEATURE
}

export async function ensureIntermediaryPortalRoleFeature(
  em: EntityManager,
  customerRbacService: Pick<CustomerRbacService, 'invalidateTenantCache'>,
  scope: IntermediaryRoleFeatureScope,
  now = new Date(),
): Promise<IntermediaryRoleFeatureResult> {
  const result = await em.transactional(async (transactionalEm) => {
    const role = await transactionalEm.findOne(
      CustomerRole,
      {
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        slug: INTERMEDIARY_ROLE_SLUG,
        deletedAt: null,
      },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    )
    if (!role) throw new Error('[internal] Scoped intermediary role not found')

    const acl = await transactionalEm.findOne(
      CustomerRoleAcl,
      {
        role: role.id,
        tenantId: scope.tenantId,
        deletedAt: null,
      },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    )
    if (!acl) throw new Error('[internal] Scoped intermediary role ACL not found')

    const currentFeatures = Array.isArray(acl.featuresJson) ? acl.featuresJson : []
    if (currentFeatures.includes(INTERMEDIARY_PORTAL_FEATURE)) {
      return { changed: false, roleId: role.id, feature: INTERMEDIARY_PORTAL_FEATURE } as const
    }

    acl.featuresJson = [...currentFeatures, INTERMEDIARY_PORTAL_FEATURE]
    role.updatedAt = now
    transactionalEm.persist(acl)
    transactionalEm.persist(role)
    await transactionalEm.flush()
    return { changed: true, roleId: role.id, feature: INTERMEDIARY_PORTAL_FEATURE } as const
  })

  await customerRbacService.invalidateTenantCache(scope.tenantId)
  return result
}
