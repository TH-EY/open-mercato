import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import { rateLimitErrorSchema } from '@open-mercato/shared/lib/ratelimit/helpers'
import {
  checkAuthRateLimit,
  customerInviteIpRateLimitConfig,
  customerInviteRateLimitConfig,
} from '@open-mercato/core/modules/customer_accounts/lib/rateLimiter'
import { readNormalizedEmailFromJsonRequest } from '@open-mercato/core/modules/customer_accounts/lib/rateLimitIdentifier'
import { intermediaryInviteSchema } from '../../../../data/validators'
import { directoryItemSchema } from '../../../../lib/directory-api'
import { executeDirectoryRouteCommand } from '../../../../lib/directory-route'
import {
  createStaffRequestContext,
  routeErrorResponse,
  unauthorizedResponse,
} from '../../../../lib/http'

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

export async function POST(req: Request) {
  try {
    const rateLimitEmail = await readNormalizedEmailFromJsonRequest(req)
    const { error } = await checkAuthRateLimit({
      req,
      ipConfig: customerInviteIpRateLimitConfig,
      compoundConfig: customerInviteRateLimitConfig,
      compoundIdentifier: rateLimitEmail,
    })
    if (error) return error
    const requestContext = await createStaffRequestContext(req)
    if (!requestContext) return unauthorizedResponse()
    const body = intermediaryInviteSchema.parse(await readJsonSafe<Record<string, unknown>>(req, {}))
    return executeDirectoryRouteCommand({
      request: req,
      requestContext,
      commandId: 'finoo_intermediaries.intermediary.invite',
      intermediaryId: 'new',
      commandInput: body,
      operation: 'create',
    })
  } catch (error) {
    return routeErrorResponse(error)
  }
}

const successSchema = z.object({
  item: directoryItemSchema,
  requiresReactivation: z.boolean().optional(),
  warningCode: z.literal('access_notice_delivery_failed').optional(),
})
const deliveryErrorSchema = successSchema.extend({ code: z.literal('invitation_delivery_failed') })

export const openApi: OpenApiRouteDoc = {
  tag: 'FINOO Intermediaries',
  summary: 'Invite or link an intermediary',
  methods: {
    POST: {
      summary: 'Create or resolve a scoped intermediary directory record',
      requestBody: { contentType: 'application/json', schema: intermediaryInviteSchema },
      responses: [
        { status: 200, description: 'Existing account linked or inactive record returned', schema: successSchema },
        { status: 201, description: 'Invitation submitted', schema: successSchema },
      ],
      errors: [
        { status: 429, description: 'Too many invitation requests', schema: rateLimitErrorSchema },
        { status: 502, description: 'Invitation delivery failed durably', schema: deliveryErrorSchema },
      ],
    },
  },
}
