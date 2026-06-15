import { acceptPortalQuote, portalQuoteAcceptOpenApi } from '../../../documents'

export const metadata: { path?: string; requireAuth?: boolean } = { requireAuth: false }

type RouteContext = {
  params: Promise<{ id: string }> | { id: string }
}

async function readId(context: RouteContext): Promise<string> {
  const params = await context.params
  return params.id
}

export async function POST(req: Request, context: RouteContext) {
  return acceptPortalQuote(req, await readId(context))
}

export const openApi = portalQuoteAcceptOpenApi
