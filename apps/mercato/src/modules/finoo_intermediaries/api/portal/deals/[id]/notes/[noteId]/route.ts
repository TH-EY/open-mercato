import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import {
  FinooIntermediaryAssignment,
  FinooIntermediaryNote,
} from '../../../../../../data/entities'
import { noteDeleteSchema, noteUpdateSchema } from '../../../../../../data/validators'
import {
  createPortalRequestContext,
  executeGuardedCommand,
  routeErrorResponse,
  unauthorizedResponse,
} from '../../../../../../lib/http'

export const metadata = {
  PUT: { requireAuth: false },
  DELETE: { requireAuth: false },
}

const pathParamsSchema = z.object({ id: z.string().uuid(), noteId: z.string().uuid() })

async function loadAssignmentId(
  requestContext: NonNullable<Awaited<ReturnType<typeof createPortalRequestContext>>>,
  dealId: string,
): Promise<string | null> {
  const assignment = await requestContext.em.findOne(FinooIntermediaryAssignment, {
    dealId,
    tenantId: requestContext.tenantId,
    organizationId: requestContext.organizationId,
    intermediaryCustomerUserId: requestContext.actorId,
    deletedAt: null,
  })
  return assignment?.id ?? null
}

export async function PUT(
  req: Request,
  { params }: { params: { id: string; noteId: string } },
) {
  try {
    const path = pathParamsSchema.parse(params)
    const requestContext = await createPortalRequestContext(req)
    if (!requestContext) return unauthorizedResponse()
    const assignmentId = await loadAssignmentId(requestContext, path.id)
    if (!assignmentId) return NextResponse.json({ error: 'Resource not found' }, { status: 404 })
    const body = noteUpdateSchema.parse(await readJsonSafe<Record<string, unknown>>(req, {}))
    const result = await executeGuardedCommand<FinooIntermediaryNote>({
      request: req,
      requestContext,
      commandId: 'finoo_intermediaries.note.update',
      commandInput: { assignmentId, noteId: path.noteId, ...body },
      resourceKind: 'finoo_intermediaries.note',
      resourceId: path.noteId,
      operation: 'update',
    })
    if (result instanceof Response) return result
    return NextResponse.json({
      note: {
        id: result.id,
        body: result.body,
        createdAt: result.createdAt.toISOString(),
        updatedAt: result.updatedAt.toISOString(),
      },
    })
  } catch (error) {
    return routeErrorResponse(error)
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: { id: string; noteId: string } },
) {
  try {
    const path = pathParamsSchema.parse(params)
    const requestContext = await createPortalRequestContext(req)
    if (!requestContext) return unauthorizedResponse()
    const assignmentId = await loadAssignmentId(requestContext, path.id)
    if (!assignmentId) return NextResponse.json({ error: 'Resource not found' }, { status: 404 })
    const body = noteDeleteSchema.parse(await readJsonSafe<Record<string, unknown>>(req, {}))
    const result = await executeGuardedCommand<FinooIntermediaryNote>({
      request: req,
      requestContext,
      commandId: 'finoo_intermediaries.note.delete',
      commandInput: { assignmentId, noteId: path.noteId, ...body },
      resourceKind: 'finoo_intermediaries.note',
      resourceId: path.noteId,
      operation: 'delete',
    })
    if (result instanceof Response) return result
    return NextResponse.json({ ok: true })
  } catch (error) {
    return routeErrorResponse(error)
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'FINOO Intermediaries',
  summary: 'Update or delete an author-owned private partner note',
  pathParams: pathParamsSchema,
  methods: {
    PUT: {
      summary: 'Update an author-owned note',
      requestBody: { contentType: 'application/json', schema: noteUpdateSchema },
      responses: [{ status: 200, description: 'Note updated', schema: z.object({ note: z.record(z.string(), z.unknown()) }) }],
    },
    DELETE: {
      summary: 'Soft-delete an author-owned note',
      requestBody: { contentType: 'application/json', schema: noteDeleteSchema },
      responses: [{ status: 200, description: 'Note deleted', schema: z.object({ ok: z.boolean() }) }],
    },
  },
}
