import type { FilterQuery } from '@mikro-orm/postgresql'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import {
  FinooIntermediaryAssignment,
  FinooIntermediaryNote,
} from '../../../../../data/entities'
import { noteCreateSchema } from '../../../../../data/validators'
import { assertPortalAssignmentAccess } from '../../../../../lib/access'
import {
  createPortalRequestContext,
  executeGuardedCommand,
  routeErrorResponse,
  unauthorizedResponse,
} from '../../../../../lib/http'
import { decodeCursor, encodeCursor } from '../../../../../lib/pagination'

export const metadata = {
  GET: { requireAuth: false },
  POST: { requireAuth: false },
}

const querySchema = z.object({
  cursor: z.string().optional(),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
})

async function loadAssignment(
  requestContext: NonNullable<Awaited<ReturnType<typeof createPortalRequestContext>>>,
  dealId: string,
) {
  const assignment = await requestContext.em.findOne(FinooIntermediaryAssignment, {
    dealId,
    tenantId: requestContext.tenantId,
    organizationId: requestContext.organizationId,
    intermediaryCustomerUserId: requestContext.actorId,
    deletedAt: null,
  } as FilterQuery<FinooIntermediaryAssignment>)
  if (!assignment) return null
  await assertPortalAssignmentAccess(requestContext.em, assignment, {
    tenantId: requestContext.tenantId,
    organizationId: requestContext.organizationId,
    customerUserId: requestContext.actorId,
  })
  return assignment
}

function serializeNote(note: FinooIntermediaryNote) {
  return {
    id: note.id,
    body: note.body,
    createdAt: note.createdAt.toISOString(),
    updatedAt: note.updatedAt.toISOString(),
  }
}

export async function GET(req: Request, { params }: { params: { id: string } }) {
  try {
    const dealId = z.string().uuid().parse(params.id)
    const requestContext = await createPortalRequestContext(req)
    if (!requestContext) return unauthorizedResponse()
    const assignment = await loadAssignment(requestContext, dealId)
    if (!assignment) return NextResponse.json({ error: 'Resource not found' }, { status: 404 })
    const query = querySchema.parse(Object.fromEntries(new URL(req.url).searchParams))
    const cursor = decodeCursor(query.cursor)
    if (query.cursor && !cursor) return NextResponse.json({ error: 'Invalid cursor' }, { status: 400 })
    const notes = await findWithDecryption(
      requestContext.em,
      FinooIntermediaryNote,
      {
        tenantId: requestContext.tenantId,
        organizationId: requestContext.organizationId,
        assignment: assignment.id,
        authorCustomerUserId: requestContext.actorId,
        deletedAt: null,
        ...(cursor ? {
          $or: [
            { createdAt: { $lt: new Date(cursor.timestamp) } },
            { createdAt: new Date(cursor.timestamp), id: { $lt: cursor.id } },
          ],
        } : {}),
      } as FilterQuery<FinooIntermediaryNote>,
      { orderBy: { createdAt: 'desc', id: 'desc' }, limit: query.pageSize + 1 },
      { tenantId: requestContext.tenantId, organizationId: requestContext.organizationId },
    )
    const page = notes.slice(0, query.pageSize)
    const last = notes.length > query.pageSize ? page.at(-1) : null
    return NextResponse.json({
      items: page.map(serializeNote),
      nextCursor: last ? encodeCursor({ timestamp: last.createdAt.toISOString(), id: last.id }) : null,
    })
  } catch (error) {
    return routeErrorResponse(error)
  }
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const dealId = z.string().uuid().parse(params.id)
    const requestContext = await createPortalRequestContext(req)
    if (!requestContext) return unauthorizedResponse()
    const body = noteCreateSchema.parse(await readJsonSafe<Record<string, unknown>>(req, {}))
    const assignment = await loadAssignment(requestContext, dealId)
    if (!assignment) return NextResponse.json({ error: 'Resource not found' }, { status: 404 })
    const result = await executeGuardedCommand<FinooIntermediaryNote>({
      request: req,
      requestContext,
      commandId: 'finoo_intermediaries.note.create',
      commandInput: { assignmentId: assignment.id, ...body },
      resourceKind: 'finoo_intermediaries.note',
      resourceId: assignment.id,
      operation: 'create',
    })
    if (result instanceof Response) return result
    return NextResponse.json({ note: serializeNote(result) }, { status: 201 })
  } catch (error) {
    return routeErrorResponse(error)
  }
}

const noteSchema = z.object({ id: z.string().uuid(), body: z.string(), createdAt: z.string(), updatedAt: z.string() })

export const openApi: OpenApiRouteDoc = {
  tag: 'FINOO Intermediaries',
  summary: 'Manage the authenticated intermediary author\'s private notes',
  pathParams: z.object({ id: z.string().uuid() }),
  methods: {
    GET: {
      summary: 'List the current author\'s notes for one assignment',
      query: querySchema,
      responses: [{ status: 200, description: 'Author-scoped notes', schema: z.object({ items: z.array(noteSchema), nextCursor: z.string().nullable() }) }],
    },
    POST: {
      summary: 'Create a private partner note',
      requestBody: { contentType: 'application/json', schema: noteCreateSchema },
      responses: [{ status: 201, description: 'Note created', schema: z.object({ note: noteSchema }) }],
    },
  },
}
