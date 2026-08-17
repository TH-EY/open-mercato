import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import { rateLimitErrorSchema } from '@open-mercato/shared/lib/ratelimit/helpers'
import { intermediaryUpdateSchema } from '../../../../data/validators'
import { directoryItemSchema } from '../../../../lib/directory-api'
import { loadDirectoryById } from '../../../../lib/directory-lifecycle'
import { executeDirectoryRouteCommand } from '../../../../lib/directory-route'
import { checkDirectoryEmailRateLimit } from '../../../../lib/directory-rate-limit'
import {
  createStaffRequestContext,
  routeErrorResponse,
  unauthorizedResponse,
} from '../../../../lib/http'

export const metadata = {
  PUT: {
    requireAuth: true,
    requireFeatures: ['finoo_intermediaries.manage'],
  },
}

const paramsSchema = z.object({ id: z.string().uuid() })

export async function PUT(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const requestContext = await createStaffRequestContext(req)
    if (!requestContext) return unauthorizedResponse()
    const { id } = paramsSchema.parse(await context.params)
    await loadDirectoryById(requestContext.em, id, requestContext)
    const body = intermediaryUpdateSchema.parse(await readJsonSafe<Record<string, unknown>>(req, {}))
    if (body.email) {
      const rateLimitResponse = await checkDirectoryEmailRateLimit(req, body.email)
      if (rateLimitResponse) return rateLimitResponse
    }
    return await executeDirectoryRouteCommand({
      request: req,
      requestContext,
      commandId: 'finoo_intermediaries.intermediary.update',
      intermediaryId: id,
      commandInput: { intermediaryId: id, ...body },
      operation: 'update',
    })
  } catch (error) {
    return routeErrorResponse(error)
  }
}

const responseSchema = z.object({ item: directoryItemSchema })
const deliveryErrorSchema = responseSchema.extend({ code: z.literal('invitation_delivery_failed') })

export const openApi: OpenApiRouteDoc = {
  tag: 'FINOO Intermediaries',
  summary: 'Update an intermediary identity',
  methods: {
    PUT: {
      summary: 'Update scoped intermediary names or pre-link email',
      requestBody: { contentType: 'application/json', schema: intermediaryUpdateSchema },
      responses: [{ status: 200, description: 'Updated intermediary', schema: responseSchema }],
      errors: [
        { status: 429, description: 'Too many invitation requests', schema: rateLimitErrorSchema },
        { status: 502, description: 'Replacement invitation delivery failed', schema: deliveryErrorSchema },
      ],
    },
  },
}
