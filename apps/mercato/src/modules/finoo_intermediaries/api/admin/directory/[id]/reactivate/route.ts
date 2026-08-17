import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { rateLimitErrorSchema } from '@open-mercato/shared/lib/ratelimit/helpers'
import { intermediaryLifecycleActionSchema } from '../../../../../data/validators'
import { directoryItemSchema } from '../../../../../lib/directory-api'
import { executeDirectoryActionRoute } from '../../../../../lib/directory-action-route'

export const metadata = {
  POST: {
    requireAuth: true,
    requireFeatures: [
      'finoo_intermediaries.manage',
      'customer_accounts.manage',
    ],
  },
}

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  return executeDirectoryActionRoute({
    request: req,
    intermediaryId: id,
    commandId: 'finoo_intermediaries.intermediary.reactivate',
    rateLimitOutboundEmail: true,
  })
}

const responseSchema = z.object({
  item: directoryItemSchema,
  warningCode: z.literal('access_notice_delivery_failed').optional(),
})
const deliveryErrorSchema = responseSchema.extend({ code: z.literal('invitation_delivery_failed') })
export const openApi: OpenApiRouteDoc = {
  tag: 'FINOO Intermediaries',
  summary: 'Reactivate an intermediary',
  methods: { POST: {
    summary: 'Restore a linked account or create a fresh invitation',
    requestBody: { contentType: 'application/json', schema: intermediaryLifecycleActionSchema },
    responses: [{ status: 200, description: 'Intermediary reactivated or invited', schema: responseSchema }],
    errors: [
      { status: 429, description: 'Too many invitation requests', schema: rateLimitErrorSchema },
      { status: 502, description: 'Invitation delivery failed durably', schema: deliveryErrorSchema },
    ],
  } },
}
