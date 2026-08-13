import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandBus } from '@open-mercato/shared/lib/commands'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { getCustomerAuthFromRequest, requireCustomerFeature } from '@open-mercato/core/modules/customer_accounts/lib/customerAuth'
import type { CustomerRbacService } from '@open-mercato/core/modules/customer_accounts/services/customerRbacService'
import { FinooAffiliate, FinooAffiliatePayout } from '../../../data/entities'
import { finooPayoutsQuerySchema } from '../../../data/validators'
import { reconcileAffiliateForUser } from '../../../lib/membership'

export const metadata = { GET: { requireAuth: false } }

export async function GET(request: Request): Promise<Response> {
  const auth = await getCustomerAuthFromRequest(request)
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const parsed = finooPayoutsQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams.entries()))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid query' }, { status: 400 })
  const container = await createRequestContainer()
  try { await requireCustomerFeature(auth, ['portal.finoo_affiliates.view'], container.resolve('customerRbacService') as CustomerRbacService) } catch (response) { return response as Response }
  const scope = { tenantId: auth.tenantId, organizationId: auth.orgId }
  const em = container.resolve('em') as EntityManager
  const commandBus = container.resolve('commandBus') as CommandBus
  const affiliate = await reconcileAffiliateForUser(
    em,
    auth.sub,
    scope,
    async (invitationId, userId, activationScope) => {
      const { result } = await commandBus.execute<Record<string, unknown>, FinooAffiliate>(
        'finoo_affiliates.affiliate.activate',
        {
          input: { invitationId, userId, ...activationScope },
          ctx: {
            container,
            auth: null,
            organizationScope: null,
            selectedOrganizationId: activationScope.organizationId,
            organizationIds: [activationScope.organizationId],
            systemActor: true,
          },
        },
      )
      return result
    },
  )
  if (!affiliate) return NextResponse.json({ error: 'AFFILIATE_NOT_FOUND' }, { status: 403 })
  const where = { ...scope, affiliateId: affiliate.id }
  const [payouts, total] = await Promise.all([
    findWithDecryption(em, FinooAffiliatePayout, where, { orderBy: { paidAt: 'DESC' }, limit: parsed.data.pageSize, offset: (parsed.data.page - 1) * parsed.data.pageSize }, scope),
    em.count(FinooAffiliatePayout, where),
  ])
  return NextResponse.json({ items: payouts.map((payout) => ({ id: payout.id, paidAt: payout.paidAt.toISOString(), paymentReference: payout.paymentReference, amount: payout.amount, currency: payout.currency })), total, page: parsed.data.page, pageSize: parsed.data.pageSize })
}

export const openApi: OpenApiRouteDoc = { tag: 'Finoo Affiliate Portal', methods: { GET: { summary: 'List own affiliate payouts', query: finooPayoutsQuerySchema, responses: [{ status: 200, description: 'Own payouts', schema: z.object({ items: z.array(z.object({ id: z.string().uuid(), paidAt: z.string().datetime(), paymentReference: z.string(), amount: z.string(), currency: z.string() })), total: z.number(), page: z.number(), pageSize: z.number() }) }] } } }
