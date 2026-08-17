import type { AwilixContainer } from 'awilix'
import type { EntityManager } from '@mikro-orm/postgresql'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import {
  getCustomerAuthFromRequest,
  requireCustomerFeature,
  type CustomerAuthContext,
} from '@open-mercato/core/modules/customer_accounts/lib/customerAuth'
import type { CustomerRbacService } from '@open-mercato/core/modules/customer_accounts/services/customerRbacService'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import type { CommandBus, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import {
  runRouteMutationGuards,
  type RouteMutationGuardOperation,
} from '@open-mercato/shared/lib/crud/route-mutation-guard'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { createLogger } from '@open-mercato/shared/lib/logger'

const logger = createLogger('finoo_intermediaries')

export type RequestCommandContext = {
  container: AwilixContainer
  em: EntityManager
  ctx: CommandRuntimeContext
  tenantId: string
  organizationId: string
  actorId: string
}

export type PortalRequestContext = RequestCommandContext & {
  customerAuth: CustomerAuthContext
}

export async function createStaffRequestContext(req: Request): Promise<RequestCommandContext | null> {
  const container = await createRequestContainer()
  const auth = await getAuthFromRequest(req)
  if (!auth?.tenantId || !auth.sub) return null
  const actorUserId = auth.userId ?? (auth.isApiKey ? null : auth.sub)
  if (!actorUserId || !z.string().uuid().safeParse(actorUserId).success) return null
  const scope = await resolveOrganizationScopeForRequest({ container, auth, request: req })
  const organizationId = scope?.selectedId ?? auth.orgId ?? null
  if (!organizationId) return null
  const ctx: CommandRuntimeContext = {
    container,
    auth: { ...auth, userId: actorUserId },
    organizationScope: scope,
    selectedOrganizationId: organizationId,
    organizationIds: scope?.filterIds ?? [organizationId],
    request: req,
  }
  return {
    container,
    em: container.resolve('em') as EntityManager,
    ctx,
    tenantId: auth.tenantId,
    organizationId,
    actorId: actorUserId,
  }
}

export async function createPortalRequestContext(req: Request): Promise<PortalRequestContext | null> {
  const customerAuth = await getCustomerAuthFromRequest(req)
  if (!customerAuth) return null
  const container = await createRequestContainer()
  const customerRbacService = container.resolve('customerRbacService') as CustomerRbacService
  await requireCustomerFeature(
    customerAuth,
    ['portal.finoo_intermediaries.view'],
    customerRbacService,
  )
  const ctx: CommandRuntimeContext = {
    container,
    auth: customerAuth as unknown as CommandRuntimeContext['auth'],
    organizationScope: null,
    selectedOrganizationId: customerAuth.orgId,
    organizationIds: [customerAuth.orgId],
    request: req,
  }
  return {
    container,
    em: container.resolve('em') as EntityManager,
    ctx,
    tenantId: customerAuth.tenantId,
    organizationId: customerAuth.orgId,
    actorId: customerAuth.sub,
    customerAuth,
  }
}

export async function executeGuardedCommand<TResult>(input: {
  request: Request
  requestContext: RequestCommandContext
  commandId: string
  commandInput: Record<string, unknown>
  resourceKind: string
  resourceId: string
  operation: Exclude<RouteMutationGuardOperation, 'custom'>
}): Promise<TResult | NextResponse> {
  const guardResult = await runRouteMutationGuards({
    container: input.requestContext.container,
    req: input.request,
    auth: {
      tenantId: input.requestContext.tenantId,
      organizationId: input.requestContext.organizationId,
      userId: input.requestContext.actorId,
    },
    input: {
      resourceKind: input.resourceKind,
      resourceId: input.resourceId,
      operation: input.operation,
      mutationPayload: input.commandInput,
    },
  })
  if (!guardResult.ok) return guardResult.response as NextResponse
  const commandBus = input.requestContext.container.resolve('commandBus') as CommandBus
  const { result } = await commandBus.execute<Record<string, unknown>, TResult>(input.commandId, {
    input: guardResult.modifiedPayload ?? input.commandInput,
    ctx: input.requestContext.ctx,
    metadata: {
      tenantId: input.requestContext.tenantId,
      organizationId: input.requestContext.organizationId,
      actorUserId: input.requestContext.actorId,
      resourceKind: input.resourceKind,
      resourceId: input.resourceId,
    },
  })
  await guardResult.runAfterSuccess()
  return result
}

export function routeErrorResponse(error: unknown): NextResponse {
  if (error instanceof Response) return error as NextResponse
  if (isCrudHttpError(error)) {
    return NextResponse.json(error.body, { status: error.status })
  }
  if (error instanceof z.ZodError) {
    return NextResponse.json({ error: 'Validation failed', details: error.issues }, { status: 400 })
  }
  logger.error('FINOO intermediary route failed', { error })
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
}

export function unauthorizedResponse(): NextResponse {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
}
