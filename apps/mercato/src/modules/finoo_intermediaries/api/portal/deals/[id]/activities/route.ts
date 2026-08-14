import type { FilterQuery } from '@mikro-orm/postgresql'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { FinooIntermediaryAssignment } from '../../../../../data/entities'
import { assertPortalAssignmentAccess } from '../../../../../lib/access'
import {
  createPortalRequestContext,
  routeErrorResponse,
  unauthorizedResponse,
} from '../../../../../lib/http'
import { decodeNullableCursor, encodeNullableCursor } from '../../../../../lib/pagination'
import {
  loadPortalActivities,
  loadPrimaryPersonEntityId,
} from '../../../../../lib/projection'

export const metadata = { GET: { requireAuth: false } }

const querySchema = z.object({
  cursor: z.string().optional(),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
})

export async function GET(req: Request, { params }: { params: { id: string } }) {
  try {
    const dealId = z.string().uuid().parse(params.id)
    const requestContext = await createPortalRequestContext(req)
    if (!requestContext) return unauthorizedResponse()
    const query = querySchema.parse(Object.fromEntries(new URL(req.url).searchParams))
    const cursor = decodeNullableCursor(query.cursor)
    if (query.cursor && !cursor) return NextResponse.json({ error: 'Invalid cursor' }, { status: 400 })
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
    const personEntityId = await loadPrimaryPersonEntityId(requestContext.em, {
      dealId: assignment.dealId,
      tenantId: requestContext.tenantId,
      organizationId: requestContext.organizationId,
    })
    const activities = await loadPortalActivities(requestContext.em, {
      personEntityId,
      tenantId: requestContext.tenantId,
      organizationId: requestContext.organizationId,
      pageSize: query.pageSize,
      cursor,
    })
    return NextResponse.json({
      items: activities.items,
      nextCursor: activities.nextCursor ? encodeNullableCursor(activities.nextCursor) : null,
    })
  } catch (error) {
    return routeErrorResponse(error)
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'FINOO Intermediaries',
  summary: 'List the safe read-only primary-Person activity projection',
  pathParams: z.object({ id: z.string().uuid() }),
  methods: {
    GET: {
      summary: 'List allowlisted non-email activities',
      query: querySchema,
      responses: [{
        status: 200,
        description: 'Safe activity projection',
        schema: z.object({
          items: z.array(z.object({
            id: z.string().uuid(),
            type: z.string(),
            occurredAt: z.string().nullable(),
            direction: z.null(),
            summary: z.string().max(300),
          })),
          nextCursor: z.string().nullable(),
        }),
      }],
    },
  },
}
