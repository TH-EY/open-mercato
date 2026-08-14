import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandBus } from '@open-mercato/shared/lib/commands'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { runRouteMutationGuards } from '@open-mercato/shared/lib/crud/route-mutation-guard'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import {
  getCustomerAuthFromRequest,
  requireCustomerFeature,
} from '@open-mercato/core/modules/customer_accounts/lib/customerAuth'
import type { CustomerRbacService } from '@open-mercato/core/modules/customer_accounts/services/customerRbacService'
import { FinooAffiliate } from '../../../data/entities'
import { finooAffiliateProfileSchema } from '../../../data/validators'
import { reconcileAffiliateForUser } from '../../../lib/membership'

export const metadata = {
  GET: { requireAuth: false },
  PUT: { requireAuth: false },
}

async function resolvePortal(request: Request, features: string[]) {
  const auth = await getCustomerAuthFromRequest(request)
  if (!auth) return null
  const container = await createRequestContainer()
  const rbac = container.resolve('customerRbacService') as CustomerRbacService
  await requireCustomerFeature(auth, features, rbac)
  return { auth, container, scope: { tenantId: auth.tenantId, organizationId: auth.orgId } }
}

async function resolveAffiliate(
  em: EntityManager,
  resolved: NonNullable<Awaited<ReturnType<typeof resolvePortal>>>,
): Promise<FinooAffiliate | null> {
  const commandBus = resolved.container.resolve('commandBus') as CommandBus
  return reconcileAffiliateForUser(
    em,
    resolved.auth.sub,
    resolved.scope,
    async (invitationId, userId, scope) => {
      const { result } = await commandBus.execute<Record<string, unknown>, FinooAffiliate>(
        'finoo_affiliates.affiliate.activate',
        {
          input: { invitationId, userId, ...scope },
          ctx: {
            container: resolved.container,
            auth: null,
            organizationScope: null,
            selectedOrganizationId: scope.organizationId,
            organizationIds: [scope.organizationId],
            systemActor: true,
          },
        },
      )
      return result
    },
  )
}

export async function GET(request: Request): Promise<Response> {
  try {
    const resolved = await resolvePortal(request, ['portal.finoo_affiliates.view'])
    if (!resolved) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const em = resolved.container.resolve('em') as EntityManager
    const affiliate = await resolveAffiliate(em, resolved)
    if (!affiliate) return NextResponse.json({ error: 'AFFILIATE_NOT_FOUND' }, { status: 403 })
    return NextResponse.json({
      accountHolderName: affiliate.accountHolderName ?? '',
      accountNumber: affiliate.accountNumber ?? '',
      updatedAt: affiliate.updatedAt.toISOString(),
    })
  } catch (error) {
    if (error instanceof Response) return error
    throw error
  }
}

export async function PUT(request: Request): Promise<Response> {
  try {
    const resolved = await resolvePortal(request, ['portal.finoo_affiliates.profile.manage'])
    if (!resolved) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const em = resolved.container.resolve('em') as EntityManager
    if (!await resolveAffiliate(em, resolved)) {
      return NextResponse.json({ error: 'AFFILIATE_NOT_FOUND' }, { status: 403 })
    }
    const parsed = finooAffiliateProfileSchema.safeParse(await readJsonSafe(request, null))
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 })
    const guarded = await runRouteMutationGuards({
      container: resolved.container,
      req: request,
      auth: { userId: resolved.auth.sub, ...resolved.scope },
      input: {
        resourceKind: 'finoo_affiliates.affiliate',
        resourceId: resolved.auth.sub,
        operation: 'update',
        mutationPayload: parsed.data,
      },
    })
    if (!guarded.ok) return guarded.response
    const input = finooAffiliateProfileSchema.parse(guarded.modifiedPayload ?? parsed.data)
    const commandBus = resolved.container.resolve('commandBus') as CommandBus
    const { result } = await commandBus.execute<Record<string, unknown>, FinooAffiliate>(
      'finoo_affiliates.affiliate.update_profile',
      {
        input,
        ctx: {
          container: resolved.container,
          auth: resolved.auth as never,
          organizationScope: null,
          selectedOrganizationId: resolved.scope.organizationId,
          organizationIds: [resolved.scope.organizationId],
          request,
        },
      },
    )
    await guarded.runAfterSuccess()
    return NextResponse.json({
      accountHolderName: result.accountHolderName ?? '',
      accountNumber: result.accountNumber ?? '',
      updatedAt: result.updatedAt.toISOString(),
    })
  } catch (error) {
    if (error instanceof Response) return error
    if (isCrudHttpError(error)) return NextResponse.json(error.body, { status: error.status })
    throw error
  }
}

const profileResponse = z.object({
  accountHolderName: z.string(),
  accountNumber: z.string(),
  updatedAt: z.string().datetime(),
})

export const openApi: OpenApiRouteDoc = {
  tag: 'Finoo Affiliate Portal',
  methods: {
    GET: { summary: 'Get own affiliate bank profile', responses: [{ status: 200, description: 'Own profile', schema: profileResponse }] },
    PUT: { summary: 'Update own affiliate bank profile', requestBody: { schema: finooAffiliateProfileSchema }, responses: [{ status: 200, description: 'Updated profile', schema: profileResponse }] },
  },
}
