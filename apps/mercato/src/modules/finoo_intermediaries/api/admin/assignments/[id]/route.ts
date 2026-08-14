import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import { FinooIntermediaryAssignment } from '../../../../data/entities'
import { assignmentDeleteSchema, assignmentUpdateSchema } from '../../../../data/validators'
import {
  createStaffRequestContext,
  executeGuardedCommand,
  routeErrorResponse,
  unauthorizedResponse,
} from '../../../../lib/http'

export const metadata = {
  PUT: { requireAuth: true, requireFeatures: ['finoo_intermediaries.manage'] },
  DELETE: { requireAuth: true, requireFeatures: ['finoo_intermediaries.manage'] },
}

const pathSchema = z.object({ id: z.string().uuid() })

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

export async function PUT(req: Request, { params }: { params: { id: string } }) {
  try {
    const { id } = pathSchema.parse(params)
    const requestContext = await createStaffRequestContext(req)
    if (!requestContext) return unauthorizedResponse()
    const body = assignmentUpdateSchema.parse(await readJsonSafe<Record<string, unknown>>(req, {}))
    const result = await executeGuardedCommand<FinooIntermediaryAssignment>({
      request: req,
      requestContext,
      commandId: 'finoo_intermediaries.assignment.update',
      commandInput: { assignmentId: id, ...body },
      resourceKind: 'finoo_intermediaries.assignment',
      resourceId: id,
      operation: 'update',
    })
    if (result instanceof Response) return result
    return NextResponse.json({ assignment: serializeAssignment(result) })
  } catch (error) {
    return routeErrorResponse(error)
  }
}

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  try {
    const { id } = pathSchema.parse(params)
    const requestContext = await createStaffRequestContext(req)
    if (!requestContext) return unauthorizedResponse()
    const body = assignmentDeleteSchema.parse(await readJsonSafe<Record<string, unknown>>(req, {}))
    const result = await executeGuardedCommand<FinooIntermediaryAssignment>({
      request: req,
      requestContext,
      commandId: 'finoo_intermediaries.assignment.delete',
      commandInput: { assignmentId: id, ...body },
      resourceKind: 'finoo_intermediaries.assignment',
      resourceId: id,
      operation: 'delete',
    })
    if (result instanceof Response) return result
    return NextResponse.json({ ok: true })
  } catch (error) {
    return routeErrorResponse(error)
  }
}

const assignmentResponseSchema = z.object({
  assignment: z.object({
    id: z.string().uuid(),
    dealId: z.string().uuid(),
    intermediaryCustomerUserId: z.string().uuid(),
    intermediaryRoleId: z.string().uuid(),
    eligibleStageId: z.string().uuid(),
    partnerStatus: z.enum(['new', 'in_progress', 'done']),
    statusUpdatedAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
})

const errorSchema = z.object({ error: z.string() })

export const openApi: OpenApiRouteDoc = {
  tag: 'FINOO Intermediaries',
  summary: 'Update one intermediary assignment',
  methods: {
    PUT: {
      summary: 'Reassign an intermediary Deal',
      requestBody: { contentType: 'application/json', schema: assignmentUpdateSchema },
      responses: [{ status: 200, description: 'Assignment updated', schema: assignmentResponseSchema }],
      errors: [{ status: 409, description: 'Optimistic-lock conflict', schema: errorSchema }],
    },
    DELETE: {
      summary: 'Soft-delete an intermediary assignment',
      requestBody: { contentType: 'application/json', schema: assignmentDeleteSchema },
      responses: [{ status: 200, description: 'Assignment removed', schema: z.object({ ok: z.boolean() }) }],
      errors: [{ status: 409, description: 'Optimistic-lock conflict', schema: errorSchema }],
    },
  },
}
