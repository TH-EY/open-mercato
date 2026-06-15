import { getPortalQuoteDetail, portalQuoteDetailOpenApi } from '../../documents'

export const metadata: { path?: string; requireAuth?: boolean } = { requireAuth: false }

type RouteContext = {
  params: Promise<{ id: string }> | { id: string }
}

async function readId(context: RouteContext): Promise<string> {
  const params = await context.params
  return params.id
}

export async function GET(req: Request, context: RouteContext) {
  return getPortalQuoteDetail(req, await readId(context))
}

export const openApi = portalQuoteDetailOpenApi
