import { NextResponse } from 'next/server'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { SearchService } from '@open-mercato/search'
import {
  createStaffRequestContext,
  routeErrorResponse,
  unauthorizedResponse,
} from '../../../lib/http'
import {
  directoryQuerySchema,
  directoryResponseSchema,
  loadDirectoryPage,
} from '../../../lib/directory-api'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['finoo_intermediaries.view'] },
}

export async function GET(req: Request) {
  try {
    const requestContext = await createStaffRequestContext(req)
    if (!requestContext) return unauthorizedResponse()
    const query = directoryQuerySchema.parse(Object.fromEntries(new URL(req.url).searchParams))
    const searchService = requestContext.container.resolve('searchService') as SearchService | undefined
    const result = await loadDirectoryPage({
      em: requestContext.em,
      searchService,
      scope: requestContext,
      query,
    })
    return NextResponse.json(result)
  } catch (error) {
    return routeErrorResponse(error)
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'FINOO Intermediaries',
  summary: 'List the scoped intermediary directory',
  methods: {
    GET: {
      summary: 'Search and filter intermediary lifecycle records',
      query: directoryQuerySchema,
      responses: [{ status: 200, description: 'Directory page', schema: directoryResponseSchema }],
    },
  },
}
