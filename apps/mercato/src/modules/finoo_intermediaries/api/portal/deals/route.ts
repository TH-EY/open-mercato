import type { FilterQuery } from '@mikro-orm/postgresql'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { FinooIntermediaryAssignment } from '../../../data/entities'
import {
  filterAuthorizedPortalAssignments,
  portalAssignmentWhere,
} from '../../../lib/access'
import {
  createPortalRequestContext,
  routeErrorResponse,
  unauthorizedResponse,
} from '../../../lib/http'
import { decodeCursor, encodeCursor } from '../../../lib/pagination'
import { buildPortalDealProjections } from '../../../lib/projection'

export const metadata = { GET: { requireAuth: false } }

const querySchema = z.object({
  cursor: z.string().optional(),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
})

export async function GET(req: Request) {
  try {
    const requestContext = await createPortalRequestContext(req)
    if (!requestContext) return unauthorizedResponse()
    const query = querySchema.parse(Object.fromEntries(new URL(req.url).searchParams))
    const cursor = decodeCursor(query.cursor)
    if (query.cursor && !cursor) return NextResponse.json({ error: 'Invalid cursor' }, { status: 400 })
    let scanCursor = cursor
    const authorized: FinooIntermediaryAssignment[] = []
    while (authorized.length < query.pageSize + 1) {
      const where: FilterQuery<FinooIntermediaryAssignment> = {
        ...portalAssignmentWhere({
          tenantId: requestContext.tenantId,
          organizationId: requestContext.organizationId,
          customerUserId: requestContext.actorId,
        }),
        ...(scanCursor ? {
          $or: [
            { updatedAt: { $lt: new Date(scanCursor.timestamp) } },
            { updatedAt: new Date(scanCursor.timestamp), id: { $lt: scanCursor.id } },
          ],
        } : {}),
      }
      const candidates = await requestContext.em.find(FinooIntermediaryAssignment, where, {
        orderBy: { updatedAt: 'desc', id: 'desc' },
        limit: query.pageSize + 1,
      })
      if (candidates.length === 0) break
      authorized.push(...await filterAuthorizedPortalAssignments(requestContext.em, candidates, {
        tenantId: requestContext.tenantId,
        organizationId: requestContext.organizationId,
        customerUserId: requestContext.actorId,
      }))
      if (candidates.length < query.pageSize + 1) break
      const last = candidates.at(-1)!
      scanCursor = { timestamp: last.updatedAt.toISOString(), id: last.id }
    }
    const page = authorized.slice(0, query.pageSize)
    const items = await buildPortalDealProjections(requestContext.em, page, {
      tenantId: requestContext.tenantId,
      organizationId: requestContext.organizationId,
    })
    const lastAssignment = authorized.length > query.pageSize ? page.at(-1) : null
    return NextResponse.json({
      items,
      nextCursor: lastAssignment
        ? encodeCursor({ timestamp: lastAssignment.updatedAt.toISOString(), id: lastAssignment.id })
        : null,
    })
  } catch (error) {
    return routeErrorResponse(error)
  }
}

const portalDealSchema = z.object({
  id: z.string().uuid(),
  assignmentId: z.string().uuid(),
  updatedAt: z.string(),
  companyName: z.string().nullable(),
  companyPhone: z.string().nullable(),
  personMobile: z.string().nullable(),
  personEmail: z.string().nullable(),
  turnover: z.number().nullable(),
  businessStartDate: z.string().nullable(),
  arrears: z.boolean().nullable(),
  industry: z.string().nullable(),
  partnerStatus: z.enum(['new', 'in_progress', 'done']),
})

export const openApi: OpenApiRouteDoc = {
  tag: 'FINOO Intermediaries',
  summary: 'List Deals assigned to the authenticated intermediary',
  methods: {
    GET: {
      summary: 'List eligible assigned Deals',
      query: querySchema,
      responses: [{
        status: 200,
        description: 'Allowlisted assigned Deal page',
        schema: z.object({ items: z.array(portalDealSchema), nextCursor: z.string().nullable() }),
      }],
    },
  },
}
