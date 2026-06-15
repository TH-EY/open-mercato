import { listPortalQuotes, portalQuotesOpenApi } from './documents'

export const metadata: { path?: string; requireAuth?: boolean } = { requireAuth: false }

export const GET = listPortalQuotes
export const openApi = portalQuotesOpenApi
