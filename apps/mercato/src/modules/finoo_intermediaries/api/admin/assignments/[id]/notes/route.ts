import type { FilterQuery } from '@mikro-orm/postgresql'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { FinooIntermediaryAssignment } from '../../../../../data/entities'
import {
  createStaffRequestContext,
  routeErrorResponse,
  unauthorizedResponse,
} from '../../../../../lib/http'
import { decodeCursor, encodeCursor } from '../../../../../lib/pagination'
import { loadStaffNotes } from '../../../../../lib/staff-notes'

export const metadata = { GET: { requireAuth: true, requireFeatures: ['finoo_intermediaries.view'] } }

const querySchema = z.object({
  cursor: z.string().optional(),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
})

export async function GET(req: Request, { params }: { params: { id: string } }) {
  try {
    const assignmentId = z.string().uuid().parse(params.id)
    const requestContext = await createStaffRequestContext(req)
    if (!requestContext) return unauthorizedResponse()
    const query = querySchema.parse(Object.fromEntries(new URL(req.url).searchParams))
    const cursor = decodeCursor(query.cursor)
    if (query.cursor && !cursor) return NextResponse.json({ error: 'Invalid cursor' }, { status: 400 })
    const assignment = await requestContext.em.findOne(FinooIntermediaryAssignment, {
      id: assignmentId,
      tenantId: requestContext.tenantId,
      organizationId: requestContext.organizationId,
      deletedAt: null,
    } as FilterQuery<FinooIntermediaryAssignment>)
    if (!assignment) return NextResponse.json({ error: 'Resource not found' }, { status: 404 })
    const notes = await loadStaffNotes(requestContext.em, {
      assignmentId: assignment.id,
      tenantId: requestContext.tenantId,
      organizationId: requestContext.organizationId,
      pageSize: query.pageSize,
      cursor,
    })
    return NextResponse.json({
      items: notes.items,
      nextCursor: notes.nextCursor ? encodeCursor(notes.nextCursor) : null,
    })
  } catch (error) {
    return routeErrorResponse(error)
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'FINOO Intermediaries',
  summary: 'Read all private intermediary notes for staff audit',
  pathParams: z.object({ id: z.string().uuid() }),
  methods: {
    GET: {
      summary: 'List assignment notes for authorized staff',
      query: querySchema,
      responses: [{ status: 200, description: 'Staff note audit projection', schema: z.object({ items: z.array(z.object({
        id: z.string().uuid(),
        authorCustomerUserId: z.string().uuid(),
        body: z.string(),
        createdAt: z.string(),
        updatedAt: z.string(),
      })), nextCursor: z.string().nullable() }) }],
    },
  },
}
