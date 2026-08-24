import type { EntityManager } from '@mikro-orm/postgresql'
import { NextResponse } from 'next/server'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import type { OrganizationScope } from '@open-mercato/core/modules/directory/utils/organizationScope'
import type { FinooCustomerRetentionSettingsService } from '../../services/settingsService'

export type RetentionSettingsRouteContext = {
  auth: NonNullable<Awaited<ReturnType<typeof getAuthFromRequest>>>
  container: Awaited<ReturnType<typeof createRequestContainer>>
  em: EntityManager
  service: FinooCustomerRetentionSettingsService
  tenantId: string
  organizationId: string
  organizationScope: OrganizationScope
}

export async function resolveRetentionSettingsContext(
  request: Request,
): Promise<RetentionSettingsRouteContext | NextResponse> {
  const auth = await getAuthFromRequest(request)
  if (!auth?.sub || !auth.tenantId) {
    return NextResponse.json(
      { error: 'Unauthorized', code: 'unauthorized' },
      { status: 401 },
    )
  }
  const container = await createRequestContainer()
  const scope = await resolveOrganizationScopeForRequest({ container, auth, request })
  const tenantId = scope.tenantId ?? auth.tenantId
  const organizationId = scope.selectedId ?? auth.orgId ?? null
  if (!organizationId || !tenantId) {
    return NextResponse.json(
      { error: 'Select an organization to access retention settings', code: 'organization_scope_required' },
      { status: 400 },
    )
  }
  if (scope.filterIds && !scope.filterIds.includes(organizationId)) {
    return NextResponse.json(
      { error: 'Organization scope mismatch', code: 'organization_scope_mismatch' },
      { status: 403 },
    )
  }
  return {
    auth,
    container,
    em: container.resolve<EntityManager>('em'),
    service: container.resolve<FinooCustomerRetentionSettingsService>(
      'finooCustomerRetentionSettingsService',
    ),
    tenantId,
    organizationId,
    organizationScope: scope,
  }
}
