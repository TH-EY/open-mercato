import { downloadPortalDocumentAttachment, portalQuoteAttachmentDownloadOpenApi } from '../../../../documents'

export const metadata: { path?: string; requireAuth?: boolean } = { requireAuth: false }

type RouteContext = {
  params: Promise<{ id: string; attachmentId: string }> | { id: string; attachmentId: string }
}

async function readParams(context: RouteContext): Promise<{ id: string; attachmentId: string }> {
  return context.params
}

export async function GET(req: Request, context: RouteContext) {
  const { id, attachmentId } = await readParams(context)
  return downloadPortalDocumentAttachment(req, 'quotes', id, attachmentId)
}

export const openApi = portalQuoteAttachmentDownloadOpenApi
