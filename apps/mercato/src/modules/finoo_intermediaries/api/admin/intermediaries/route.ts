import type { FilterQuery } from '@mikro-orm/postgresql'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import {
  CustomerRole,
  CustomerUser,
  CustomerUserRole,
} from '@open-mercato/core/modules/customer_accounts/data/entities'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import {
  createStaffRequestContext,
  routeErrorResponse,
  unauthorizedResponse,
} from '../../../lib/http'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['finoo_intermediaries.manage'] },
}

const querySchema = z.object({
  query: z.string().trim().max(100).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
})

export async function GET(req: Request) {
  try {
    const requestContext = await createStaffRequestContext(req)
    if (!requestContext) return unauthorizedResponse()
    const query = querySchema.parse(Object.fromEntries(new URL(req.url).searchParams))
    const roles = await requestContext.em.find(CustomerRole, {
      tenantId: requestContext.tenantId,
      organizationId: requestContext.organizationId,
      slug: 'intermediary',
      deletedAt: null,
    } as FilterQuery<CustomerRole>)
    if (roles.length !== 1) {
      return NextResponse.json({ error: 'Intermediary role configuration is ambiguous or missing' }, { status: 422 })
    }
    const role = roles[0]
    const memberships = await requestContext.em.find(CustomerUserRole, {
      role: role.id,
      deletedAt: null,
      user: {
        tenantId: requestContext.tenantId,
        organizationId: requestContext.organizationId,
        isActive: true,
        deletedAt: null,
      },
    } as FilterQuery<CustomerUserRole>, { populate: ['user'] })
    const userIds = memberships.map((membership) => membership.user.id)
    const users = userIds.length
      ? await findWithDecryption(
          requestContext.em,
          CustomerUser,
          {
            id: { $in: userIds },
            tenantId: requestContext.tenantId,
            organizationId: requestContext.organizationId,
            isActive: true,
            deletedAt: null,
          } as FilterQuery<CustomerUser>,
          undefined,
          { tenantId: requestContext.tenantId, organizationId: requestContext.organizationId },
        )
      : []
    const normalizedSearch = query.query?.toLowerCase()
    const items = users
      .filter((user) => !normalizedSearch || (
        user.displayName.toLowerCase().includes(normalizedSearch)
        || user.email.toLowerCase().includes(normalizedSearch)
      ))
      .sort((left, right) => (
        left.displayName.localeCompare(right.displayName)
        || left.id.localeCompare(right.id)
      ))
      .slice(0, query.pageSize)
      .map((user) => ({ id: user.id, displayName: user.displayName, email: user.email }))
    return NextResponse.json({ items })
  } catch (error) {
    return routeErrorResponse(error)
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'FINOO Intermediaries',
  summary: 'List active intermediary role members',
  methods: {
    GET: {
      summary: 'List scoped active intermediary role members',
      query: querySchema,
      responses: [{
        status: 200,
        description: 'Intermediary picker options',
        schema: z.object({
          items: z.array(z.object({ id: z.string().uuid(), displayName: z.string(), email: z.string().email() })),
        }),
      }],
    },
  },
}
