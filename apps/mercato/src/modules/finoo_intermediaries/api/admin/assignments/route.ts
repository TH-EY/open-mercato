import type { FilterQuery } from '@mikro-orm/postgresql'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import {
  assignmentCreateSchema,
} from '../../../data/validators'
import { FinooIntermediaryAssignment } from '../../../data/entities'
import {
  createStaffRequestContext,
  executeGuardedCommand,
  routeErrorResponse,
  unauthorizedResponse,
} from '../../../lib/http'
import { encodeCursor } from '../../../lib/pagination'
import { loadStaffNotes } from '../../../lib/staff-notes'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['finoo_intermediaries.view'] },
  POST: { requireAuth: true, requireFeatures: ['finoo_intermediaries.manage'] },
}

const assignmentQuerySchema = z.object({ dealId: z.string().uuid() })

function serializeAssignment(assignment: FinooIntermediaryAssignment) {
  return {
    id: assignment.id,
    dealId: assignment.dealId,
    intermediaryCustomerUserId: assignment.intermediaryCustomerUserId,
    intermediaryRoleId: assignment.intermediaryRoleId,
    eligibleStageId: assignment.eligibleStageId,
    partnerStatus: assignment.partnerStatus,
    statusUpdatedAt: assignment.statusUpdatedAt?.toISOString() ?? null,
    createdAt: assignment.createdAt.toISOString(),
    updatedAt: assignment.updatedAt.toISOString(),
  }
}

export async function GET(req: Request) {
  try {
    const requestContext = await createStaffRequestContext(req)
    if (!requestContext) return unauthorizedResponse()
    const query = assignmentQuerySchema.parse(Object.fromEntries(new URL(req.url).searchParams))
    const assignment = await requestContext.em.findOne(FinooIntermediaryAssignment, {
      tenantId: requestContext.tenantId,
      organizationId: requestContext.organizationId,
      dealId: query.dealId,
      deletedAt: null,
    } as FilterQuery<FinooIntermediaryAssignment>)
    const notes = assignment
      ? await loadStaffNotes(requestContext.em, {
          assignmentId: assignment.id,
          tenantId: requestContext.tenantId,
          organizationId: requestContext.organizationId,
          pageSize: 50,
        })
      : { items: [], nextCursor: null }
    return NextResponse.json({
      assignment: assignment ? serializeAssignment(assignment) : null,
      notes: notes.items,
      notesNextCursor: notes.nextCursor ? encodeCursor(notes.nextCursor) : null,
    })
  } catch (error) {
    return routeErrorResponse(error)
  }
}

export async function POST(req: Request) {
  try {
    const requestContext = await createStaffRequestContext(req)
    if (!requestContext) return unauthorizedResponse()
    const input = assignmentCreateSchema.parse(await readJsonSafe<Record<string, unknown>>(req, {}))
    const result = await executeGuardedCommand<FinooIntermediaryAssignment>({
      request: req,
      requestContext,
      commandId: 'finoo_intermediaries.assignment.create',
      commandInput: input,
      resourceKind: 'finoo_intermediaries.assignment',
      resourceId: input.dealId,
      operation: 'create',
    })
    if (result instanceof Response) return result
    return NextResponse.json({ assignment: serializeAssignment(result) }, { status: 201 })
  } catch (error) {
    return routeErrorResponse(error)
  }
}

const assignmentViewSchema = z.object({
    id: z.string().uuid(),
    dealId: z.string().uuid(),
    intermediaryCustomerUserId: z.string().uuid(),
    intermediaryRoleId: z.string().uuid(),
    eligibleStageId: z.string().uuid(),
    partnerStatus: z.enum(['new', 'in_progress', 'done']),
    statusUpdatedAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
})
const assignmentResponseSchema = z.object({ assignment: assignmentViewSchema.nullable() })
const assignmentReadResponseSchema = assignmentResponseSchema.extend({
  notes: z.array(z.object({
    id: z.string().uuid(),
    authorCustomerUserId: z.string().uuid(),
    body: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })),
  notesNextCursor: z.string().nullable(),
})
const errorSchema = z.object({ error: z.string() })

export const openApi: OpenApiRouteDoc = {
  tag: 'FINOO Intermediaries',
  summary: 'Manage one intermediary assignment for a Deal',
  methods: {
    GET: {
      summary: 'Read the active intermediary assignment for a Deal',
      query: assignmentQuerySchema,
      responses: [{ status: 200, description: 'Assignment result with the first staff-note page', schema: assignmentReadResponseSchema }],
      errors: [{ status: 401, description: 'Unauthorized', schema: errorSchema }],
    },
    POST: {
      summary: 'Assign an eligible Deal to an intermediary',
      requestBody: { contentType: 'application/json', schema: assignmentCreateSchema },
      responses: [{ status: 201, description: 'Assignment created', schema: assignmentResponseSchema }],
      errors: [{ status: 409, description: 'Assignment or stage conflict', schema: errorSchema }],
    },
  },
}
