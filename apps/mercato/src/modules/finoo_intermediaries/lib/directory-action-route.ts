import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import { z } from 'zod'
import { intermediaryLifecycleActionSchema } from '../data/validators'
import { loadDirectoryById } from './directory-lifecycle'
import { checkDirectoryEmailRateLimit } from './directory-rate-limit'
import { executeDirectoryRouteCommand } from './directory-route'
import {
  createStaffRequestContext,
  routeErrorResponse,
  unauthorizedResponse,
} from './http'

export async function executeDirectoryActionRoute(input: {
  request: Request
  intermediaryId: string
  commandId: string
  rateLimitOutboundEmail?: boolean
}) {
  try {
    const intermediaryId = z.string().uuid().parse(input.intermediaryId)
    const requestContext = await createStaffRequestContext(input.request)
    if (!requestContext) return unauthorizedResponse()
    const intermediary = await loadDirectoryById(
      requestContext.em,
      intermediaryId,
      requestContext,
    )
    if (input.rateLimitOutboundEmail) {
      const rateLimitResponse = await checkDirectoryEmailRateLimit(
        input.request,
        intermediary.email,
      )
      if (rateLimitResponse) return rateLimitResponse
    }
    const body = intermediaryLifecycleActionSchema.parse(
      await readJsonSafe<Record<string, unknown>>(input.request, {}),
    )
    return await executeDirectoryRouteCommand({
      request: input.request,
      requestContext,
      commandId: input.commandId,
      intermediaryId,
      commandInput: { intermediaryId, ...body },
      operation: 'update',
    })
  } catch (error) {
    return routeErrorResponse(error)
  }
}
