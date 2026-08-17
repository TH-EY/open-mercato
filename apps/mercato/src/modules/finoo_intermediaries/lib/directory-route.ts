import { NextResponse } from 'next/server'
import type { z } from 'zod'
import type { DirectoryCommandResult } from '../commands/directory'
import type {
  intermediaryInviteSchema,
  intermediaryLifecycleActionSchema,
  intermediaryUpdateSchema,
} from '../data/validators'
import type { RequestCommandContext } from './http'
import { executeGuardedCommand } from './http'
import { serializeDirectoryCommandResult } from './directory-api'

type DirectoryMutationInput =
  | z.infer<typeof intermediaryInviteSchema>
  | z.infer<typeof intermediaryUpdateSchema>
  | z.infer<typeof intermediaryLifecycleActionSchema>

export async function executeDirectoryRouteCommand(input: {
  request: Request
  requestContext: RequestCommandContext
  commandId: string
  intermediaryId: string
  commandInput: DirectoryMutationInput & Record<string, unknown>
  operation: 'create' | 'update'
}): Promise<NextResponse> {
  const result = await executeGuardedCommand<DirectoryCommandResult>({
    request: input.request,
    requestContext: input.requestContext,
    commandId: input.commandId,
    commandInput: input.commandInput,
    resourceKind: 'finoo_intermediaries.intermediary',
    resourceId: input.intermediaryId,
    operation: input.operation,
  })
  if (result instanceof Response) return result as NextResponse
  const response = await serializeDirectoryCommandResult(
    input.requestContext.em,
    result,
    input.requestContext,
  )
  if (result.deliveryFailed) {
    return NextResponse.json({ code: 'invitation_delivery_failed', ...response }, { status: 502 })
  }
  const status = input.commandId.endsWith('.invite') && response.item.status === 'invited' ? 201 : 200
  return NextResponse.json(response, { status })
}
