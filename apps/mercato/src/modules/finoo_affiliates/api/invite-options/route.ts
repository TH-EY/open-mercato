import { z } from 'zod'
import { NextResponse } from 'next/server'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { EntityManager } from '@mikro-orm/postgresql'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import { loadAffiliateRole, resolveDefaultAffiliateDestination } from '../../lib/membership'

export const metadata = { GET: { requireAuth: true, requireFeatures: ['finoo_affiliates.manage'] } }

export async function GET(request: Request): Promise<Response> {
  const auth = await getAuthFromRequest(request)
  if (!auth?.tenantId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const container = await createRequestContainer()
  const organizationScope = await resolveOrganizationScopeForRequest({ container, auth, request })
  const organizationId = organizationScope.selectedId ?? auth.orgId
  if (!organizationId) return NextResponse.json({ error: 'Organization is required' }, { status: 400 })
  const role = await loadAffiliateRole(container.resolve('em') as EntityManager, auth.tenantId)
  if (!role) return NextResponse.json({ error: 'Affiliate role is not configured' }, { status: 409 })
  let defaultDestinationReady = true
  try {
    resolveDefaultAffiliateDestination()
  } catch {
    defaultDestinationReady = false
  }
  return NextResponse.json({ ok: true, affiliateRoleId: role.id, defaultDestinationReady })
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Finoo Affiliates',
  methods: {
    GET: {
      summary: 'Get Finoo affiliate invitation options',
      responses: [{ status: 200, description: 'Affiliate role and destination readiness', schema: z.object({ ok: z.literal(true), affiliateRoleId: z.string().uuid(), defaultDestinationReady: z.boolean() }) }],
    },
  },
}
