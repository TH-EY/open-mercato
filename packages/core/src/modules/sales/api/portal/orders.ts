import { listPortalOrders, portalOrdersOpenApi } from './documents'

export const metadata: { path?: string; requireAuth?: boolean } = { requireAuth: false }

export const GET = listPortalOrders
export const openApi = portalOrdersOpenApi
