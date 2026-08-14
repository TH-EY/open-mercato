import { z } from 'zod'
import { NextResponse } from 'next/server'
import type { EntityManager, FilterQuery, QueryOrderMap } from '@mikro-orm/postgresql'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import { CustomerUser } from '@open-mercato/core/modules/customer_accounts/data/entities'
import { CustomerPersonProfile } from '@open-mercato/core/modules/customers/data/entities'
import { FinooAffiliateTransaction } from '../../data/entities'
import { finooAffiliateTransactionsQuerySchema } from '../../data/validators'
import { resolveAffiliateName } from '../../lib/affiliateNames'

export const metadata = { GET: { requireAuth: true, requireFeatures: ['finoo_affiliates.view'] } }

function orderBy(input: z.infer<typeof finooAffiliateTransactionsQuerySchema>): QueryOrderMap<FinooAffiliateTransaction> {
  const direction = input.sortDir === 'asc' ? 'ASC' : 'DESC'
  if (input.sortField === 'commissionAmount') return { commissionAmount: direction }
  if (input.sortField === 'commissionStatus') return { commissionStatus: direction }
  return { acceptedAt: direction }
}

export async function GET(request: Request): Promise<Response> {
  const auth = await getAuthFromRequest(request)
  if (!auth?.tenantId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const parsed = finooAffiliateTransactionsQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams.entries()))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid query' }, { status: 400 })
  const container = await createRequestContainer()
  const organizationScope = await resolveOrganizationScopeForRequest({ container, auth, request })
  const organizationId = organizationScope.selectedId ?? auth.orgId
  if (!organizationId) return NextResponse.json({ error: 'Organization is required' }, { status: 400 })
  const em = container.resolve('em') as EntityManager
  const scope = { tenantId: auth.tenantId, organizationId }
  const where: FilterQuery<FinooAffiliateTransaction> = {
    ...scope,
    ...(parsed.data.status ? { commissionStatus: parsed.data.status } : {}),
  }
  const [transactions, total] = await Promise.all([
    findWithDecryption(
      em,
      FinooAffiliateTransaction,
      where,
      {
        orderBy: orderBy(parsed.data),
        limit: parsed.data.pageSize,
        offset: (parsed.data.page - 1) * parsed.data.pageSize,
      },
      scope,
    ),
    em.count(FinooAffiliateTransaction, where),
  ])
  const userIds = [...new Set(transactions.map((transaction) => transaction.affiliateUserId))]
  const users = userIds.length > 0
    ? await findWithDecryption(em, CustomerUser, { id: { $in: userIds }, ...scope, deletedAt: null }, undefined, scope)
    : []
  const usersById = new Map(users.map((user) => [user.id, user]))
  const personIds = users.flatMap((user) => user.personEntityId ? [user.personEntityId] : [])
  const people = personIds.length > 0
    ? await findWithDecryption(em, CustomerPersonProfile, { entity: { $in: personIds }, ...scope }, { populate: ['entity'] }, scope)
    : []
  const peopleByEntityId = new Map(people.map((person) => [person.entity.id, person]))

  return NextResponse.json({
    items: transactions.map((transaction) => {
      const user = usersById.get(transaction.affiliateUserId)
      const person = user?.personEntityId ? peopleByEntityId.get(user.personEntityId) : undefined
      const name = resolveAffiliateName(user?.displayName ?? '', person)
      return {
        id: transaction.id,
        affiliateFirstName: name.firstName,
        affiliateLastName: name.lastName,
        dealName: transaction.dealName ?? null,
        dealCompany: transaction.dealCompany ?? null,
        commissionAmount: transaction.commissionAmount,
        currency: transaction.currency,
        commissionStatus: transaction.commissionStatus,
        acceptedAt: transaction.acceptedAt.toISOString(),
        updatedAt: transaction.updatedAt.toISOString(),
      }
    }),
    total,
    page: parsed.data.page,
    pageSize: parsed.data.pageSize,
  })
}

const itemSchema = z.object({
  id: z.string().uuid(),
  affiliateFirstName: z.string(),
  affiliateLastName: z.string(),
  dealName: z.string().nullable(),
  dealCompany: z.string().nullable(),
  commissionAmount: z.number().int().min(0),
  currency: z.string(),
  commissionStatus: z.enum(['processing', 'approved', 'rejected', 'paid_out']),
  acceptedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})

export const openApi: OpenApiRouteDoc = {
  tag: 'Finoo Affiliates',
  methods: {
    GET: {
      summary: 'List Finoo affiliate transactions',
      query: finooAffiliateTransactionsQuerySchema,
      responses: [{ status: 200, description: 'Paginated affiliate transactions', schema: z.object({ items: z.array(itemSchema), total: z.number(), page: z.number(), pageSize: z.number() }) }],
    },
  },
}
