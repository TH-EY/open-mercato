import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
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
    commandId: 'finoo_intermediaries.invitation.cancel',
  })
}

export const openApi: OpenApiRouteDoc = {
  tag: 'FINOO Intermediaries',
  summary: 'Cancel an intermediary invitation',
  methods: { POST: {
    summary: 'Invalidate the current invitation and preserve an inactive record',
    requestBody: { contentType: 'application/json', schema: intermediaryLifecycleActionSchema },
    responses: [{ status: 200, description: 'Invitation cancelled', schema: z.object({ item: directoryItemSchema }) }],
  } },
}
