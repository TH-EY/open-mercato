import type { EntityManager } from '@mikro-orm/postgresql'
import { GET as getCorePortalNav } from '@open-mercato/core/modules/customer_accounts/api/portal/nav'
import { getCustomerAuthFromRequest } from '@open-mercato/core/modules/customer_accounts/lib/customerAuth'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import {
  filterIntermediaryDashboardNav,
  hasActiveIntermediaryPortalRole,
} from '../lib/portalNavigation'

type PortalNavGroup = {
  items: Array<{ href: string; [key: string]: unknown }>
  [key: string]: unknown
}

function isPortalNavGroups(value: unknown): value is PortalNavGroup[] {
  return Array.isArray(value) && value.every((group) => {
    if (!group || typeof group !== 'object') return false
    const items = Reflect.get(group, 'items')
    return Array.isArray(items) && items.every((item) => (
      !!item
      && typeof item === 'object'
      && typeof Reflect.get(item, 'href') === 'string'
    ))
  })
}

export async function GET(request: Request): Promise<Response> {
  const response = await getCorePortalNav(request)
  if (!response.ok) return response

  const payload: unknown = await response.clone().json()
  if (!payload || typeof payload !== 'object') return response
  const orgSlug = Reflect.get(payload, 'orgSlug')
  const groups = Reflect.get(payload, 'groups')
  if (
    typeof orgSlug !== 'string'
    || !isPortalNavGroups(groups)
  ) {
    return response
  }

  const auth = await getCustomerAuthFromRequest(request)
  if (!auth) return response

  const container = await createRequestContainer()
  const em = container.resolve('em') as EntityManager
  const isIntermediary = await hasActiveIntermediaryPortalRole(em, {
    tenantId: auth.tenantId,
    organizationId: auth.orgId,
    customerUserId: auth.sub,
  })
  if (!isIntermediary) return response

  return Response.json({
    ...payload,
    groups: filterIntermediaryDashboardNav(groups, orgSlug),
  }, {
    status: response.status,
    headers: response.headers,
  })
}
