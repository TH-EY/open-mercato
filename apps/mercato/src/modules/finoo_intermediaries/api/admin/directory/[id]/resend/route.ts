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
      'customer_accounts.invite',
      'customer_accounts.manage',
    ],
  },
}

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  return executeDirectoryActionRoute({
    request: req,
    intermediaryId: id,
    commandId: 'finoo_intermediaries.invitation.resend',
    rateLimitOutboundEmail: true,
  })
}

const responseSchema = z.object({ item: directoryItemSchema })
const deliveryErrorSchema = responseSchema.extend({ code: z.literal('invitation_delivery_failed') })
export const openApi: OpenApiRouteDoc = {
  tag: 'FINOO Intermediaries',
  summary: 'Resend an intermediary invitation',
  methods: { POST: {
    summary: 'Rotate and resend the scoped invitation',
    requestBody: { contentType: 'application/json', schema: intermediaryLifecycleActionSchema },
    responses: [{ status: 200, description: 'Invitation submitted', schema: responseSchema }],
    errors: [
      { status: 429, description: 'Too many invitation requests', schema: rateLimitErrorSchema },
      { status: 502, description: 'Invitation delivery failed durably', schema: deliveryErrorSchema },
    ],
  } },
}
