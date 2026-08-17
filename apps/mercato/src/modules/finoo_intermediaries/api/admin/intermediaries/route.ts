import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import {
  createStaffRequestContext,
  routeErrorResponse,
  unauthorizedResponse,
} from '../../../lib/http'
import { loadEligibleIntermediaryUsers } from '../../../lib/access'

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
    const { users } = await loadEligibleIntermediaryUsers(requestContext.em, requestContext)
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
