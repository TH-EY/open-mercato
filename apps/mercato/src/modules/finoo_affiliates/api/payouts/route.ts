import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import { CustomerUser } from '@open-mercato/core/modules/customer_accounts/data/entities'
import { CustomerPersonProfile } from '@open-mercato/core/modules/customers/data/entities'
import { FinooAffiliatePayout } from '../../data/entities'
import { finooPayoutsQuerySchema } from '../../data/validators'
import { resolveAffiliateName } from '../../lib/affiliateNames'

export const metadata = { GET: { requireAuth: true, requireFeatures: ['finoo_affiliates.view'] } }

type CountRow = { payout_id: string; transaction_count: string | number }

export async function GET(request: Request): Promise<Response> {
  const auth = await getAuthFromRequest(request)
  if (!auth?.tenantId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const parsed = finooPayoutsQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams.entries()))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid query' }, { status: 400 })
  const container = await createRequestContainer()
  const organizationScope = await resolveOrganizationScopeForRequest({ container, auth, request })
  const organizationId = organizationScope.selectedId ?? auth.orgId
  if (!organizationId) return NextResponse.json({ error: 'Organization is required' }, { status: 400 })
  const scope = { tenantId: auth.tenantId, organizationId }
  const em = container.resolve('em') as EntityManager
  const [payouts, total] = await Promise.all([
    findWithDecryption(em, FinooAffiliatePayout, scope, {
      orderBy: { paidAt: 'DESC' }, limit: parsed.data.pageSize, offset: (parsed.data.page - 1) * parsed.data.pageSize,
    }, scope),
    em.count(FinooAffiliatePayout, scope),
  ])
  const userIds = [...new Set(payouts.map((payout) => payout.affiliateUserId))]
  const users = userIds.length ? await findWithDecryption(em, CustomerUser, { ...scope, id: { $in: userIds } }, undefined, scope) : []
  const peopleIds = users.flatMap((user) => user.personEntityId ? [user.personEntityId] : [])
  const people = peopleIds.length ? await findWithDecryption(em, CustomerPersonProfile, { ...scope, entity: { $in: peopleIds } }, { populate: ['entity'] }, scope) : []
  const usersById = new Map(users.map((user) => [user.id, user]))
  const peopleById = new Map(people.map((person) => [person.entity.id, person]))
  const payoutIds = payouts.map((payout) => payout.id)
  const payoutIdPlaceholders = payoutIds.map(() => '?').join(', ')
  const counts = payoutIds.length ? await em.getConnection().execute<CountRow[]>(
    `select payout_id, count(*)::int as transaction_count from finoo_affiliate_transactions
      where tenant_id = ? and organization_id = ? and payout_id in (${payoutIdPlaceholders}) group by payout_id`,
    [scope.tenantId, scope.organizationId, ...payoutIds],
  ) : []
  const countById = new Map(counts.map((row) => [row.payout_id, Number(row.transaction_count)]))
  return NextResponse.json({
    items: payouts.map((payout) => {
      const user = usersById.get(payout.affiliateUserId)
      const person = user?.personEntityId ? peopleById.get(user.personEntityId) : undefined
      const name = resolveAffiliateName(user?.displayName ?? '', person)
      return {
        id: payout.id, affiliateFirstName: name.firstName, affiliateLastName: name.lastName,
        paymentReference: payout.paymentReference, amount: payout.amount, currency: payout.currency,
        paidAt: payout.paidAt.toISOString(), transactionCount: countById.get(payout.id) ?? 0,
      }
    }), total, page: parsed.data.page, pageSize: parsed.data.pageSize,
  })
}

const itemSchema = z.object({ id: z.string().uuid(), affiliateFirstName: z.string(), affiliateLastName: z.string(), paymentReference: z.string(), amount: z.string(), currency: z.string(), paidAt: z.string().datetime(), transactionCount: z.number().int() })
export const openApi: OpenApiRouteDoc = { tag: 'Finoo Affiliates', methods: { GET: { summary: 'List affiliate payouts', query: finooPayoutsQuerySchema, responses: [{ status: 200, description: 'Payout list', schema: z.object({ items: z.array(itemSchema), total: z.number(), page: z.number(), pageSize: z.number() }) }] } } }
