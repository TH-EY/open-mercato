import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import {
  CustomerRole,
  CustomerUser,
  CustomerUserRole,
} from '@open-mercato/core/modules/customer_accounts/data/entities'
import type { ScopedCustomerUserInput } from './access'

type PortalNavItem = {
  href: string
  [key: string]: unknown
}

type PortalNavGroup = {
  items: PortalNavItem[]
  [key: string]: unknown
}

export function filterIntermediaryDashboardNav<T extends PortalNavGroup>(
  groups: T[],
  orgSlug: string,
): T[] {
  const dashboardHref = `/${orgSlug}/portal/dashboard`
  return groups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => item.href !== dashboardHref),
    }))
    .filter((group) => group.items.length > 0) as T[]
}

export async function hasActiveIntermediaryPortalRole(
  em: EntityManager,
  input: ScopedCustomerUserInput,
): Promise<boolean> {
  const roles = await em.find(CustomerRole, {
    tenantId: input.tenantId,
    organizationId: input.organizationId,
    slug: 'intermediary',
    deletedAt: null,
  } as FilterQuery<CustomerRole>)
  if (roles.length !== 1) return false

  const user = await em.findOne(CustomerUser, {
    id: input.customerUserId,
    tenantId: input.tenantId,
    organizationId: input.organizationId,
    isActive: true,
    deletedAt: null,
  } as FilterQuery<CustomerUser>)
  if (!user) return false

  const membership = await em.findOne(CustomerUserRole, {
    user: user.id,
    role: roles[0].id,
    deletedAt: null,
  } as FilterQuery<CustomerUserRole>)
  return membership !== null
}
