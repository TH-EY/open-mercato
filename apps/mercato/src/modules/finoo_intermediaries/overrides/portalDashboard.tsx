import type { EntityManager } from '@mikro-orm/postgresql'
import PortalDashboardPage from '@open-mercato/core/modules/portal/frontend/[orgSlug]/portal/dashboard/page'
import { getCustomerAuthFromCookies } from '@open-mercato/core/modules/customer_accounts/lib/customerAuthServer'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { redirect } from 'next/navigation'
import { hasActiveIntermediaryPortalRole } from '../lib/portalNavigation'

type Props = {
  params: { orgSlug: string }
}

export default async function FinooPortalDashboardPage({ params }: Props) {
  const auth = await getCustomerAuthFromCookies()
  if (auth) {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const isIntermediary = await hasActiveIntermediaryPortalRole(em, {
      tenantId: auth.tenantId,
      organizationId: auth.orgId,
      customerUserId: auth.sub,
    })
    if (isIntermediary) {
      redirect(`/${params.orgSlug}/portal/intermediary/deals`)
    }
  }

  return <PortalDashboardPage params={params} />
}
