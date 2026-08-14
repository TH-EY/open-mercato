import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import { FinooIntermediaryAssignment } from '../../../../../data/entities'
import { partnerStatusUpdateSchema } from '../../../../../data/validators'
import {
  createPortalRequestContext,
  executeGuardedCommand,
  routeErrorResponse,
  unauthorizedResponse,
} from '../../../../../lib/http'

export const metadata = { PUT: { requireAuth: false } }

export async function PUT(req: Request, { params }: { params: { id: string } }) {
  try {
    const dealId = z.string().uuid().parse(params.id)
    const requestContext = await createPortalRequestContext(req)
    if (!requestContext) return unauthorizedResponse()
    const body = partnerStatusUpdateSchema.parse(await readJsonSafe<Record<string, unknown>>(req, {}))
    const assignment = await requestContext.em.findOne(FinooIntermediaryAssignment, {
      dealId,
      tenantId: requestContext.tenantId,
      organizationId: requestContext.organizationId,
      intermediaryCustomerUserId: requestContext.actorId,
      deletedAt: null,
    })
    if (!assignment) return NextResponse.json({ error: 'Resource not found' }, { status: 404 })
    const result = await executeGuardedCommand<FinooIntermediaryAssignment>({
      request: req,
      requestContext,
      commandId: 'finoo_intermediaries.partner_status.update',
      commandInput: {
        assignmentId: assignment.id,
        partnerStatus: body.status,
        expectedUpdatedAt: body.expectedUpdatedAt,
      },
      resourceKind: 'finoo_intermediaries.assignment',
      resourceId: assignment.id,
      operation: 'update',
    })
    if (result instanceof Response) return result
    return NextResponse.json({
      status: result.partnerStatus,
      statusUpdatedAt: result.statusUpdatedAt?.toISOString() ?? null,
      updatedAt: result.updatedAt.toISOString(),
    })
  } catch (error) {
    return routeErrorResponse(error)
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'FINOO Intermediaries',
  summary: 'Advance the intermediary-owned partner status',
  pathParams: z.object({ id: z.string().uuid() }),
  methods: {
    PUT: {
      summary: 'Advance partner status by one legal edge',
      requestBody: { contentType: 'application/json', schema: partnerStatusUpdateSchema },
      responses: [{
        status: 200,
        description: 'Partner status advanced',
        schema: z.object({
          status: z.enum(['new', 'in_progress', 'done']),
          statusUpdatedAt: z.string().nullable(),
          updatedAt: z.string(),
        }),
      }],
      errors: [{ status: 409, description: 'Illegal transition or stale write', schema: z.object({ error: z.string() }) }],
    },
  },
}
