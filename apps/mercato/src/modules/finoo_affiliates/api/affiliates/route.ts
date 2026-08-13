import { z } from 'zod'
import { NextResponse } from 'next/server'
import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { lookupHashCandidates } from '@open-mercato/shared/lib/encryption/aes'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import { CustomerUser } from '@open-mercato/core/modules/customer_accounts/data/entities'
import { CustomerPersonProfile } from '@open-mercato/core/modules/customers/data/entities'
import { FinooAffiliate } from '../../data/entities'
import { resolveAffiliateName } from '../../lib/affiliateNames'
import { normalizeAffiliateEmail } from '../../lib/membership'

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  sortField: z.enum(['createdAt', 'email', 'code', 'isActive']).default('createdAt'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
  search: z.string().trim().max(320).optional(),
})

type CountRow = { affiliate_id: string; related_deals: number | string }

export const metadata = { GET: { requireAuth: true, requireFeatures: ['finoo_affiliates.view'] } }

export async function GET(request: Request): Promise<Response> {
  const auth = await getAuthFromRequest(request)
  if (!auth?.tenantId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams.entries()))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid query' }, { status: 400 })
  const container = await createRequestContainer()
  const organizationScope = await resolveOrganizationScopeForRequest({ container, auth, request })
  const organizationId = organizationScope.selectedId ?? auth.orgId
  if (!organizationId) return NextResponse.json({ error: 'Organization is required' }, { status: 400 })
  const em = container.resolve('em') as EntityManager
  const scope = { tenantId: auth.tenantId, organizationId }
  const search = parsed.data.search
  const where: FilterQuery<FinooAffiliate> = {
    ...scope,
    deletedAt: null,
    ...(search ? {
      $or: [
        { code: { $ilike: `%${search}%` } },
        { emailHash: { $in: lookupHashCandidates(normalizeAffiliateEmail(search)) } },
      ],
    } : {}),
  }
  const sortMap = {
    createdAt: 'createdAt',
    email: 'emailHash',
    code: 'code',
    isActive: 'isActive',
  } as const
  const [affiliates, total] = await Promise.all([
    findWithDecryption(
      em,
      FinooAffiliate,
      where,
      {
        orderBy: { [sortMap[parsed.data.sortField]]: parsed.data.sortDir === 'asc' ? 'ASC' : 'DESC' },
        limit: parsed.data.pageSize,
        offset: (parsed.data.page - 1) * parsed.data.pageSize,
      },
      scope,
    ),
    em.count(FinooAffiliate, where),
  ])
  const userIds = affiliates.flatMap((affiliate) => affiliate.customerUserId ? [affiliate.customerUserId] : [])
  const users = userIds.length > 0
    ? await findWithDecryption(em, CustomerUser, { id: { $in: userIds }, ...scope, deletedAt: null }, undefined, scope)
    : []
  const usersById = new Map(users.map((user) => [user.id, user]))
  const personIds = users.flatMap((user) => user.personEntityId ? [user.personEntityId] : [])
  const people = personIds.length > 0
    ? await findWithDecryption(em, CustomerPersonProfile, { entity: { $in: personIds }, ...scope }, { populate: ['entity'] }, scope)
    : []
  const peopleByEntityId = new Map(people.map((person) => [person.entity.id, person]))
  const affiliateIds = affiliates.map((affiliate) => affiliate.id)
  const affiliateIdPlaceholders = affiliateIds.map(() => '?').join(', ')
  const counts = affiliateIds.length > 0
    ? await em.getConnection().execute<CountRow[]>(
        `select affiliate_id, count(*)::int as related_deals
         from finoo_deal_attributions
         where tenant_id = ? and organization_id = ? and deleted_at is null and affiliate_id in (${affiliateIdPlaceholders})
         group by affiliate_id`,
        [scope.tenantId, scope.organizationId, ...affiliateIds],
      )
    : []
  const countsByAffiliate = new Map(counts.map((row) => [row.affiliate_id, Number(row.related_deals)]))

  return NextResponse.json({
    items: affiliates.map((affiliate) => {
      const user = affiliate.customerUserId ? usersById.get(affiliate.customerUserId) : undefined
      const person = user?.personEntityId ? peopleByEntityId.get(user.personEntityId) : undefined
      const name = resolveAffiliateName(user?.displayName ?? '', person)
      return {
        id: affiliate.id,
        email: affiliate.email,
        firstName: name.firstName,
        lastName: name.lastName,
        code: affiliate.code,
        trackedUrl: affiliate.isActive
          ? new URL(`/api/finoo_affiliates/r/${affiliate.code}`, request.url).toString()
          : '',
        relatedDeals: countsByAffiliate.get(affiliate.id) ?? 0,
        state: affiliate.isActive ? 'active' : 'invited',
        updatedAt: affiliate.updatedAt.toISOString(),
      }
    }),
    total,
    page: parsed.data.page,
    pageSize: parsed.data.pageSize,
  })
}

const itemSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  firstName: z.string(),
  lastName: z.string(),
  code: z.string(),
  trackedUrl: z.string(),
  relatedDeals: z.number().int().min(0),
  state: z.enum(['invited', 'active']),
  updatedAt: z.string().datetime(),
})

export const openApi: OpenApiRouteDoc = {
  tag: 'Finoo Affiliates',
  methods: {
    GET: {
      summary: 'List Finoo affiliate memberships',
      query: querySchema,
      responses: [{ status: 200, description: 'Paginated affiliate memberships', schema: z.object({ items: z.array(itemSchema), total: z.number(), page: z.number(), pageSize: z.number() }) }],
    },
  },
}
