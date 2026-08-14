import type { FilterQuery } from '@mikro-orm/postgresql'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { FinooIntermediaryAssignment } from '../../../../data/entities'
import { assertPortalAssignmentAccess } from '../../../../lib/access'
import {
  createPortalRequestContext,
  routeErrorResponse,
  unauthorizedResponse,
} from '../../../../lib/http'
import { buildPortalDealProjections } from '../../../../lib/projection'

export const metadata = { GET: { requireAuth: false } }

export async function GET(req: Request, { params }: { params: { id: string } }) {
  try {
    const dealId = z.string().uuid().parse(params.id)
    const requestContext = await createPortalRequestContext(req)
    if (!requestContext) return unauthorizedResponse()
    const assignment = await requestContext.em.findOne(FinooIntermediaryAssignment, {
      dealId,
      tenantId: requestContext.tenantId,
      organizationId: requestContext.organizationId,
      intermediaryCustomerUserId: requestContext.actorId,
      deletedAt: null,
    } as FilterQuery<FinooIntermediaryAssignment>)
    if (!assignment) return NextResponse.json({ error: 'Resource not found' }, { status: 404 })
    await assertPortalAssignmentAccess(requestContext.em, assignment, {
      tenantId: requestContext.tenantId,
      organizationId: requestContext.organizationId,
      customerUserId: requestContext.actorId,
    })
    const [deal] = await buildPortalDealProjections(requestContext.em, [assignment], {
      tenantId: requestContext.tenantId,
      organizationId: requestContext.organizationId,
    })
    if (!deal) return NextResponse.json({ error: 'Resource not found' }, { status: 404 })
    return NextResponse.json({ deal })
  } catch (error) {
    return routeErrorResponse(error)
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'FINOO Intermediaries',
  summary: 'Read one assigned intermediary Deal',
  pathParams: z.object({ id: z.string().uuid() }),
  methods: {
    GET: {
      summary: 'Read one allowlisted eligible assigned Deal',
      responses: [{ status: 200, description: 'Assigned Deal detail', schema: z.object({ deal: z.record(z.string(), z.unknown()) }) }],
      errors: [{ status: 404, description: 'Resource not found', schema: z.object({ error: z.string() }) }],
    },
  },
}
