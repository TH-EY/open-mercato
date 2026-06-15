import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager, EntityName, FilterQuery, FindOptions } from '@mikro-orm/postgresql'
import type { OpenApiMethodDoc, OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { E } from '#generated/entities.ids.generated'
import { getCustomerAuthFromRequest, requireCustomerFeature } from '@open-mercato/core/modules/customer_accounts/lib/customerAuth'
import type { CustomerAuthContext } from '@open-mercato/core/modules/customer_accounts/lib/customerAuth'
import type { CustomerRbacService } from '@open-mercato/core/modules/customer_accounts/services/customerRbacService'
import { Attachment, AttachmentPartition } from '@open-mercato/core/modules/attachments/data/entities'
import { buildAttachmentContentDisposition } from '@open-mercato/core/modules/attachments/lib/security'
import { StorageDriverFactory } from '@open-mercato/core/modules/attachments/lib/drivers'
import type { ActionLogService } from '@open-mercato/core/modules/audit_logs/services/actionLogService'
import type { ActionLog } from '@open-mercato/core/modules/audit_logs/data/entities'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { findAndCountWithDecryption, findOneWithDecryption, findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { buildIlikeTerm } from '@open-mercato/shared/lib/db/buildIlikeTerm'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { CrudHttpError, isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { buildHistoryEntries } from '../../lib/historyHelpers'
import { SalesNote, SalesOrder, SalesOrderLine, SalesQuote, SalesQuoteLine } from '../../data/entities'
import { acceptQuoteAndConvertToOrder, quoteLockOptions } from '../../lib/quoteAcceptance'

type PortalDocumentKind = 'orders' | 'quotes'

type PortalDocumentConfig<Entity extends SalesOrder | SalesQuote> = {
  kind: PortalDocumentKind
  entity: EntityName<Entity>
  feature: string
  numberField: keyof Entity & string
  responseKey: PortalDocumentKind
}

type RequestContainer = Awaited<ReturnType<typeof createRequestContainer>>

type AuthorizedPortalRequest = {
  auth: CustomerAuthContext
  container: RequestContainer
  customerRbacService: CustomerRbacService
  em: EntityManager
}

const querySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).optional(),
  search: z.string().trim().optional(),
})

const acceptPortalQuoteSchema = z.object({
  acceptedByName: z.string().trim().min(2).max(160),
  acceptedTerms: z.literal(true),
})

const portalCommentSchema = z.object({
  body: z.string().trim().min(1).max(2000),
})

type PortalDocumentQuery = z.infer<typeof querySchema>

const errorSchema = z.object({ ok: z.literal(false), error: z.string() })

const lineSchema = z.object({
  id: z.string().uuid(),
  lineNumber: z.number(),
  kind: z.string(),
  status: z.string().nullable(),
  name: z.string().nullable(),
  description: z.string().nullable(),
  comment: z.string().nullable(),
  quantity: z.string(),
  quantityUnit: z.string().nullable(),
  unitPriceNet: z.string(),
  unitPriceGross: z.string(),
  discountAmount: z.string(),
  taxRate: z.string(),
  taxAmount: z.string(),
  totalNetAmount: z.string(),
  totalGrossAmount: z.string(),
  currencyCode: z.string().nullable(),
})

const orderSchema = z.object({
  id: z.string().uuid(),
  orderNumber: z.string(),
  status: z.string().nullable(),
  fulfillmentStatus: z.string().nullable(),
  paymentStatus: z.string().nullable(),
  placedAt: z.string().nullable(),
  expectedDeliveryAt: z.string().nullable(),
  lineItemCount: z.number(),
  grandTotalGrossAmount: z.string(),
  outstandingAmount: z.string(),
  currencyCode: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const quoteSchema = z.object({
  id: z.string().uuid(),
  quoteNumber: z.string(),
  status: z.string().nullable(),
  validFrom: z.string().nullable(),
  validUntil: z.string().nullable(),
  convertedOrderId: z.string().uuid().nullable(),
  lineItemCount: z.number(),
  grandTotalGrossAmount: z.string(),
  currencyCode: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const acceptanceAuditSchema = z.object({
  source: z.string(),
  acceptedAt: z.string().nullable(),
  acceptedByName: z.string().nullable(),
  acceptedByEmail: z.string().nullable(),
  acceptedByCustomerUserId: z.string().nullable(),
  acceptedTerms: z.boolean(),
}).nullable()

const portalPaymentSchema = z.object({
  outstandingAmount: z.string(),
  paidTotalAmount: z.string(),
  paymentStatus: z.string().nullable(),
  portalPaymentUrl: z.string().nullable(),
  depositAmount: z.string().nullable(),
  instructions: z.string().nullable(),
})

const orderDetailSchema = orderSchema.extend({
  externalReference: z.string().nullable(),
  customerReference: z.string().nullable(),
  comments: z.string().nullable(),
  subtotalNetAmount: z.string(),
  subtotalGrossAmount: z.string(),
  discountTotalAmount: z.string(),
  taxTotalAmount: z.string(),
  shippingNetAmount: z.string(),
  shippingGrossAmount: z.string(),
  surchargeTotalAmount: z.string(),
  grandTotalNetAmount: z.string(),
  paidTotalAmount: z.string(),
  refundedTotalAmount: z.string(),
  acceptanceAudit: acceptanceAuditSchema,
  payment: portalPaymentSchema,
  lines: z.array(lineSchema),
})

const quoteDetailSchema = quoteSchema.extend({
  externalReference: z.string().nullable(),
  customerReference: z.string().nullable(),
  comments: z.string().nullable(),
  subtotalNetAmount: z.string(),
  subtotalGrossAmount: z.string(),
  discountTotalAmount: z.string(),
  taxTotalAmount: z.string(),
  grandTotalNetAmount: z.string(),
  canAccept: z.boolean(),
  acceptanceBlockedReason: z.string().nullable(),
  acceptanceAudit: acceptanceAuditSchema,
  lines: z.array(lineSchema),
})

const attachmentSchema = z.object({
  id: z.string().uuid(),
  fileName: z.string(),
  fileSize: z.number(),
  mimeType: z.string().nullable(),
  createdAt: z.string(),
  downloadUrl: z.string(),
})

const timelineEntrySchema = z.object({
  id: z.string(),
  occurredAt: z.string(),
  kind: z.enum(['status', 'action', 'comment']),
  action: z.string(),
  actor: z.object({
    id: z.string().nullable(),
    label: z.string(),
  }),
})

const commentSchema = z.object({
  id: z.string().uuid(),
  body: z.string(),
  authorName: z.string().nullable(),
  authorEmail: z.string().nullable(),
  createdAt: z.string(),
})

function readQuery(req: Request): PortalDocumentQuery {
  const url = new URL(req.url)
  return querySchema.parse({
    page: url.searchParams.get('page') ?? undefined,
    pageSize: url.searchParams.get('pageSize') ?? undefined,
    search: url.searchParams.get('search') ?? undefined,
  })
}

function serializeDate(value: Date | string | null | undefined): string | null {
  if (!value) return null
  if (value instanceof Date) return value.toISOString()
  return value
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function readBoolean(value: unknown): boolean {
  return value === true
}

function readSafePortalUrl(value: unknown): string | null {
  const candidate = readString(value)
  if (!candidate) return null
  if (candidate.startsWith('/')) return candidate
  try {
    const url = new URL(candidate)
    return url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

function readAcceptanceAudit(metadata: Record<string, unknown> | null | undefined) {
  const audit = readRecord(readRecord(metadata).portalAcceptance)
  if (Object.keys(audit).length === 0) return null
  return {
    source: readString(audit.source) ?? 'customer_portal',
    acceptedAt: readString(audit.acceptedAt),
    acceptedByName: readString(audit.acceptedByName),
    acceptedByEmail: readString(audit.acceptedByEmail),
    acceptedByCustomerUserId: readString(audit.acceptedByCustomerUserId),
    acceptedTerms: readBoolean(audit.acceptedTerms),
  }
}

function readPortalPayment(order: SalesOrder) {
  const metadata = readRecord(order.metadata)
  return {
    outstandingAmount: order.outstandingAmount ?? '0',
    paidTotalAmount: order.paidTotalAmount ?? '0',
    paymentStatus: order.paymentStatus ?? null,
    portalPaymentUrl: readSafePortalUrl(metadata.portalPaymentUrl),
    depositAmount: readString(metadata.portalDepositAmount),
    instructions: readString(metadata.portalPaymentInstructions),
  }
}

function requireCompanyScope(auth: CustomerAuthContext): string | NextResponse {
  if (!auth.customerEntityId) {
    return NextResponse.json({ ok: false, error: 'No company association' }, { status: 403 })
  }
  return auth.customerEntityId
}

async function authorizePortalDocumentRequest(
  req: Request,
  feature: string,
): Promise<AuthorizedPortalRequest | NextResponse> {
  const auth = await getCustomerAuthFromRequest(req)
  if (!auth) {
    return NextResponse.json({ ok: false, error: 'Authentication required' }, { status: 401 })
  }

  const container = await createRequestContainer()
  const customerRbacService = container.resolve('customerRbacService') as CustomerRbacService

  try {
    await requireCustomerFeature(auth, [feature], customerRbacService)
  } catch (response) {
    return response instanceof Response
      ? response as NextResponse
      : NextResponse.json({ ok: false, error: 'Insufficient permissions' }, { status: 403 })
  }

  const em = container.resolve('em') as EntityManager
  return { auth, container, customerRbacService, em }
}

async function hasCustomerFeature(auth: CustomerAuthContext, feature: string, customerRbacService: CustomerRbacService): Promise<boolean> {
  try {
    await requireCustomerFeature(auth, [feature], customerRbacService)
    return true
  } catch {
    return false
  }
}

function buildWhere<Entity extends SalesOrder | SalesQuote>(
  auth: CustomerAuthContext,
  customerEntityId: string,
  numberField: keyof Entity & string,
  query: PortalDocumentQuery,
): FilterQuery<Entity> {
  const where: Record<string, unknown> = {
    tenantId: auth.tenantId,
    organizationId: auth.orgId,
    customerEntityId,
    deletedAt: null,
  }

  if (query.search && query.search.length > 0) {
    where[numberField] = { $ilike: buildIlikeTerm(query.search) }
  }

  return where as FilterQuery<Entity>
}

function buildDetailWhere<Entity extends SalesOrder | SalesQuote>(
  auth: CustomerAuthContext,
  customerEntityId: string,
  id: string,
): FilterQuery<Entity> {
  return {
    id,
    tenantId: auth.tenantId,
    organizationId: auth.orgId,
    customerEntityId,
    deletedAt: null,
  } as FilterQuery<Entity>
}

function mapOrder(order: SalesOrder) {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status ?? null,
    fulfillmentStatus: order.fulfillmentStatus ?? null,
    paymentStatus: order.paymentStatus ?? null,
    placedAt: serializeDate(order.placedAt),
    expectedDeliveryAt: serializeDate(order.expectedDeliveryAt),
    lineItemCount: order.lineItemCount ?? 0,
    grandTotalGrossAmount: order.grandTotalGrossAmount ?? '0',
    outstandingAmount: order.outstandingAmount ?? '0',
    currencyCode: order.currencyCode ?? null,
    createdAt: serializeDate(order.createdAt) ?? new Date(0).toISOString(),
    updatedAt: serializeDate(order.updatedAt) ?? new Date(0).toISOString(),
  }
}

function mapQuote(quote: SalesQuote) {
  return {
    id: quote.id,
    quoteNumber: quote.quoteNumber,
    status: quote.status ?? null,
    validFrom: serializeDate(quote.validFrom),
    validUntil: serializeDate(quote.validUntil),
    convertedOrderId: quote.convertedOrderId ?? null,
    lineItemCount: quote.lineItemCount ?? 0,
    grandTotalGrossAmount: quote.grandTotalGrossAmount ?? '0',
    currencyCode: quote.currencyCode ?? null,
    createdAt: serializeDate(quote.createdAt) ?? new Date(0).toISOString(),
    updatedAt: serializeDate(quote.updatedAt) ?? new Date(0).toISOString(),
  }
}

function mapLine(line: SalesOrderLine | SalesQuoteLine) {
  return {
    id: line.id,
    lineNumber: line.lineNumber ?? 0,
    kind: line.kind ?? 'product',
    status: line.status ?? null,
    name: line.name ?? null,
    description: line.description ?? null,
    comment: line.comment ?? null,
    quantity: line.quantity ?? '0',
    quantityUnit: line.quantityUnit ?? null,
    unitPriceNet: line.unitPriceNet ?? '0',
    unitPriceGross: line.unitPriceGross ?? '0',
    discountAmount: line.discountAmount ?? '0',
    taxRate: line.taxRate ?? '0',
    taxAmount: line.taxAmount ?? '0',
    totalNetAmount: line.totalNetAmount ?? '0',
    totalGrossAmount: line.totalGrossAmount ?? '0',
    currencyCode: line.currencyCode ?? null,
  }
}

function mapOrderDetail(order: SalesOrder, lines: SalesOrderLine[]) {
  return {
    ...mapOrder(order),
    externalReference: order.externalReference ?? null,
    customerReference: order.customerReference ?? null,
    comments: order.comments ?? null,
    subtotalNetAmount: order.subtotalNetAmount ?? '0',
    subtotalGrossAmount: order.subtotalGrossAmount ?? '0',
    discountTotalAmount: order.discountTotalAmount ?? '0',
    taxTotalAmount: order.taxTotalAmount ?? '0',
    shippingNetAmount: order.shippingNetAmount ?? '0',
    shippingGrossAmount: order.shippingGrossAmount ?? '0',
    surchargeTotalAmount: order.surchargeTotalAmount ?? '0',
    grandTotalNetAmount: order.grandTotalNetAmount ?? '0',
    paidTotalAmount: order.paidTotalAmount ?? '0',
    refundedTotalAmount: order.refundedTotalAmount ?? '0',
    acceptanceAudit: readAcceptanceAudit(order.metadata),
    payment: readPortalPayment(order),
    lines: lines.map(mapLine),
  }
}

function resolveQuoteAcceptanceState(quote: SalesQuote, hasAcceptFeature: boolean): {
  canAccept: boolean
  acceptanceBlockedReason: string | null
} {
  const now = new Date()
  if (!hasAcceptFeature) return { canAccept: false, acceptanceBlockedReason: 'missing_feature' }
  if (quote.convertedOrderId) return { canAccept: false, acceptanceBlockedReason: 'converted' }
  if ((quote.status ?? null) !== 'sent') return { canAccept: false, acceptanceBlockedReason: 'invalid_status' }
  if (quote.validUntil && quote.validUntil.getTime() < now.getTime()) return { canAccept: false, acceptanceBlockedReason: 'expired' }
  return { canAccept: true, acceptanceBlockedReason: null }
}

function mapQuoteDetail(quote: SalesQuote, lines: SalesQuoteLine[], hasAcceptFeature: boolean) {
  return {
    ...mapQuote(quote),
    externalReference: quote.externalReference ?? null,
    customerReference: quote.customerReference ?? null,
    comments: quote.comments ?? null,
    subtotalNetAmount: quote.subtotalNetAmount ?? '0',
    subtotalGrossAmount: quote.subtotalGrossAmount ?? '0',
    discountTotalAmount: quote.discountTotalAmount ?? '0',
    taxTotalAmount: quote.taxTotalAmount ?? '0',
    grandTotalNetAmount: quote.grandTotalNetAmount ?? '0',
    ...resolveQuoteAcceptanceState(quote, hasAcceptFeature),
    acceptanceAudit: readAcceptanceAudit(quote.metadata),
    lines: lines.map(mapLine),
  }
}

async function loadPortalOrderForRequest(authorized: AuthorizedPortalRequest, id: string): Promise<{
  order: SalesOrder
  lines: SalesOrderLine[]
} | NextResponse> {
  const customerEntityId = requireCompanyScope(authorized.auth)
  if (customerEntityId instanceof Response) return customerEntityId as NextResponse

  const scope = { tenantId: authorized.auth.tenantId, organizationId: authorized.auth.orgId }
  const order = await findOneWithDecryption(
    authorized.em,
    SalesOrder,
    buildDetailWhere<SalesOrder>(authorized.auth, customerEntityId, id),
    {},
    scope,
  )
  if (!order) return NextResponse.json({ ok: false, error: 'Order not found' }, { status: 404 })

  const lines = await findWithDecryption(
    authorized.em,
    SalesOrderLine,
    {
      order: order.id,
      tenantId: authorized.auth.tenantId,
      organizationId: authorized.auth.orgId,
      deletedAt: null,
    },
    { orderBy: { lineNumber: 'ASC' } },
    scope,
  )
  return { order, lines }
}

async function loadPortalQuoteForRequest(authorized: AuthorizedPortalRequest, id: string): Promise<{
  quote: SalesQuote
  lines: SalesQuoteLine[]
} | NextResponse> {
  const customerEntityId = requireCompanyScope(authorized.auth)
  if (customerEntityId instanceof Response) return customerEntityId as NextResponse

  const scope = { tenantId: authorized.auth.tenantId, organizationId: authorized.auth.orgId }
  const quote = await findOneWithDecryption(
    authorized.em,
    SalesQuote,
    buildDetailWhere<SalesQuote>(authorized.auth, customerEntityId, id),
    {},
    scope,
  )
  if (!quote) return NextResponse.json({ ok: false, error: 'Quote not found' }, { status: 404 })

  const lines = await findWithDecryption(
    authorized.em,
    SalesQuoteLine,
    {
      quote: quote.id,
      tenantId: authorized.auth.tenantId,
      organizationId: authorized.auth.orgId,
      deletedAt: null,
    },
    { orderBy: { lineNumber: 'ASC' } },
    scope,
  )
  return { quote, lines }
}

async function listPortalDocuments<Entity extends SalesOrder | SalesQuote>(
  req: Request,
  config: PortalDocumentConfig<Entity>,
): Promise<NextResponse> {
  const authorized = await authorizePortalDocumentRequest(req, config.feature)
  if (authorized instanceof Response) return authorized as NextResponse

  const customerEntityId = requireCompanyScope(authorized.auth)
  if (customerEntityId instanceof Response) return customerEntityId as NextResponse

  const query = readQuery(req)
  const page = query.page ?? 1
  const pageSize = Math.min(100, query.pageSize ?? 25)
  const offset = (page - 1) * pageSize

  const where = buildWhere<Entity>(authorized.auth, customerEntityId, config.numberField, query)
  const options = {
    orderBy: { createdAt: 'DESC' },
    limit: pageSize,
    offset,
  } as unknown as FindOptions<Entity>

  const [documents, total] = await findAndCountWithDecryption(
    authorized.em,
    config.entity,
    where,
    options,
    { tenantId: authorized.auth.tenantId, organizationId: authorized.auth.orgId },
  )

  const items = config.kind === 'orders'
    ? (documents as SalesOrder[]).map(mapOrder)
    : (documents as SalesQuote[]).map(mapQuote)

  return NextResponse.json({
    ok: true,
    [config.responseKey]: items,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    page,
    pageSize,
  })
}

async function getPortalOrder(req: Request, id: string): Promise<NextResponse> {
  const authorized = await authorizePortalDocumentRequest(req, 'portal.orders.view')
  if (authorized instanceof Response) return authorized as NextResponse

  const loaded = await loadPortalOrderForRequest(authorized, id)
  if (loaded instanceof Response) return loaded as NextResponse

  return NextResponse.json({ ok: true, order: mapOrderDetail(loaded.order, loaded.lines) })
}

async function getPortalQuote(req: Request, id: string): Promise<NextResponse> {
  const authorized = await authorizePortalDocumentRequest(req, 'portal.quotes.view')
  if (authorized instanceof Response) return authorized as NextResponse

  const [loaded, hasAcceptFeature] = await Promise.all([
    loadPortalQuoteForRequest(authorized, id),
    hasCustomerFeature(authorized.auth, 'portal.quotes.accept', authorized.customerRbacService),
  ])
  if (loaded instanceof Response) return loaded as NextResponse

  return NextResponse.json({ ok: true, quote: mapQuoteDetail(loaded.quote, loaded.lines, hasAcceptFeature) })
}

export function listPortalOrders(req: Request): Promise<NextResponse> {
  return listPortalDocuments(req, {
    kind: 'orders',
    entity: SalesOrder,
    feature: 'portal.orders.view',
    numberField: 'orderNumber',
    responseKey: 'orders',
  })
}

export function listPortalQuotes(req: Request): Promise<NextResponse> {
  return listPortalDocuments(req, {
    kind: 'quotes',
    entity: SalesQuote,
    feature: 'portal.quotes.view',
    numberField: 'quoteNumber',
    responseKey: 'quotes',
  })
}

export function getPortalOrderDetail(req: Request, id: string): Promise<NextResponse> {
  return getPortalOrder(req, id)
}

export function getPortalQuoteDetail(req: Request, id: string): Promise<NextResponse> {
  return getPortalQuote(req, id)
}

function documentEntityId(kind: PortalDocumentKind): string {
  return kind === 'orders' ? E.sales.sales_order : E.sales.sales_quote
}

function documentFeature(kind: PortalDocumentKind): string {
  return kind === 'orders' ? 'portal.orders.view' : 'portal.quotes.view'
}

function documentNumber(document: SalesOrder | SalesQuote): string {
  return 'orderNumber' in document ? document.orderNumber : document.quoteNumber
}

function safePdfText(value: unknown): string {
  const text = value == null ? '' : String(value)
  return text.replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '')
}

function splitText(text: string, maxLength: number): string[] {
  const words = safePdfText(text).split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const next = current ? `${current} ${word}` : word
    if (next.length > maxLength && current) {
      lines.push(current)
      current = word
    } else {
      current = next
    }
  }
  if (current) lines.push(current)
  return lines.length > 0 ? lines : ['']
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return buffer
}

async function renderDocumentPdf(input: {
  kind: PortalDocumentKind
  document: SalesOrder | SalesQuote
  lines: Array<SalesOrderLine | SalesQuoteLine>
}): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const regular = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  let page = pdf.addPage([595.28, 841.89])
  let y = 790
  const margin = 48

  const draw = (text: string, size = 10, isBold = false) => {
    if (y < 70) {
      page = pdf.addPage([595.28, 841.89])
      y = 790
    }
    page.drawText(safePdfText(text), {
      x: margin,
      y,
      size,
      font: isBold ? bold : regular,
      color: rgb(0.1, 0.1, 0.1),
      maxWidth: 500,
      lineHeight: size + 4,
    })
    y -= size + 9
  }

  const doc = input.document
  const audit = readAcceptanceAudit(doc.metadata)
  const currency = doc.currencyCode ?? ''
  draw(input.kind === 'orders' ? 'Order' : 'Quote', 20, true)
  draw(`Document number: ${documentNumber(doc)}`, 12, true)
  draw(`Status: ${doc.status ?? '-'}`)
  draw(`Created: ${serializeDate(doc.createdAt) ?? '-'}`)
  if (doc.customerReference) draw(`Customer reference: ${doc.customerReference}`)
  if (doc.externalReference) draw(`External reference: ${doc.externalReference}`)
  draw('')
  draw('Line items', 14, true)
  for (const line of input.lines) {
    const label = line.name ?? 'Untitled item'
    draw(`#${line.lineNumber ?? ''} ${label}`, 11, true)
    if (line.description) {
      for (const part of splitText(line.description, 90)) draw(part, 9)
    }
    draw(`Qty: ${line.quantity ?? '0'} ${line.quantityUnit ?? ''} | Unit gross: ${line.unitPriceGross ?? '0'} ${currency} | Total gross: ${line.totalGrossAmount ?? '0'} ${currency}`)
  }
  draw('')
  draw('Totals', 14, true)
  draw(`Subtotal net: ${doc.subtotalNetAmount ?? '0'} ${currency}`)
  draw(`Tax: ${doc.taxTotalAmount ?? '0'} ${currency}`)
  draw(`Grand total gross: ${doc.grandTotalGrossAmount ?? '0'} ${currency}`, 11, true)
  if ('outstandingAmount' in doc) draw(`Outstanding: ${doc.outstandingAmount ?? '0'} ${currency}`)
  if (doc.comments) {
    draw('')
    draw('Notes', 14, true)
    for (const part of splitText(doc.comments, 90)) draw(part, 9)
  }
  if (audit) {
    draw('')
    draw('Acceptance', 14, true)
    draw(`Accepted by: ${audit.acceptedByName ?? '-'}${audit.acceptedByEmail ? ` (${audit.acceptedByEmail})` : ''}`)
    draw(`Accepted at: ${audit.acceptedAt ?? '-'}`)
    draw(`Terms accepted: ${audit.acceptedTerms ? 'yes' : 'no'}`)
  }

  return pdf.save()
}

async function loadPortalDocumentForKind(
  authorized: AuthorizedPortalRequest,
  kind: PortalDocumentKind,
  id: string,
): Promise<{ document: SalesOrder | SalesQuote; lines: Array<SalesOrderLine | SalesQuoteLine> } | NextResponse> {
  if (kind === 'orders') {
    const loaded = await loadPortalOrderForRequest(authorized, id)
    if (loaded instanceof Response) return loaded as NextResponse
    return { document: loaded.order, lines: loaded.lines }
  }
  const loaded = await loadPortalQuoteForRequest(authorized, id)
  if (loaded instanceof Response) return loaded as NextResponse
  return { document: loaded.quote, lines: loaded.lines }
}

export async function getPortalDocumentPdf(req: Request, kind: PortalDocumentKind, id: string): Promise<NextResponse> {
  try {
    const authorized = await authorizePortalDocumentRequest(req, documentFeature(kind))
    if (authorized instanceof Response) return authorized as NextResponse

    const loaded = await loadPortalDocumentForKind(authorized, kind, id)
    if (loaded instanceof Response) return loaded as NextResponse

    const bytes = await renderDocumentPdf({ kind, document: loaded.document, lines: loaded.lines })
    const fileName = `${kind === 'orders' ? 'order' : 'quote'}-${documentNumber(loaded.document)}.pdf`
    return new NextResponse(new Blob([toArrayBuffer(bytes)], { type: 'application/pdf' }), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': buildAttachmentContentDisposition(fileName, 'attachment'),
        'Cache-Control': 'private, max-age=60',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch (err) {
    console.error('sales.portal.document.pdf failed', err)
    return NextResponse.json({ ok: false, error: 'Failed to generate PDF' }, { status: 400 })
  }
}

function mapAttachment(kind: PortalDocumentKind, documentId: string, attachment: Attachment) {
  return {
    id: attachment.id,
    fileName: attachment.fileName,
    fileSize: attachment.fileSize,
    mimeType: attachment.mimeType ?? null,
    createdAt: serializeDate(attachment.createdAt) ?? new Date(0).toISOString(),
    downloadUrl: `/api/sales/portal/${kind}/${documentId}/attachments/${attachment.id}?download=1`,
  }
}

export async function listPortalDocumentAttachments(req: Request, kind: PortalDocumentKind, id: string): Promise<NextResponse> {
  const authorized = await authorizePortalDocumentRequest(req, documentFeature(kind))
  if (authorized instanceof Response) return authorized as NextResponse

  const loaded = await loadPortalDocumentForKind(authorized, kind, id)
  if (loaded instanceof Response) return loaded as NextResponse

  const attachments = await findWithDecryption(
    authorized.em,
    Attachment,
    {
      tenantId: authorized.auth.tenantId,
      organizationId: authorized.auth.orgId,
      entityId: documentEntityId(kind),
      recordId: id,
    },
    { orderBy: { createdAt: 'DESC' } },
    { tenantId: authorized.auth.tenantId, organizationId: authorized.auth.orgId },
  )

  return NextResponse.json({ ok: true, attachments: attachments.map((attachment) => mapAttachment(kind, id, attachment)) })
}

export async function downloadPortalDocumentAttachment(
  req: Request,
  kind: PortalDocumentKind,
  id: string,
  attachmentId: string,
): Promise<NextResponse> {
  const authorized = await authorizePortalDocumentRequest(req, documentFeature(kind))
  if (authorized instanceof Response) return authorized as NextResponse

  const loaded = await loadPortalDocumentForKind(authorized, kind, id)
  if (loaded instanceof Response) return loaded as NextResponse

  const attachment = await findOneWithDecryption(
    authorized.em,
    Attachment,
    {
      id: attachmentId,
      tenantId: authorized.auth.tenantId,
      organizationId: authorized.auth.orgId,
      entityId: documentEntityId(kind),
      recordId: id,
    },
    {},
    { tenantId: authorized.auth.tenantId, organizationId: authorized.auth.orgId },
  )
  if (!attachment) return NextResponse.json({ ok: false, error: 'Attachment not found' }, { status: 404 })

  const partition = await authorized.em.findOne(AttachmentPartition, { code: attachment.partitionCode })
  if (!partition) return NextResponse.json({ ok: false, error: 'Attachment partition misconfigured' }, { status: 500 })

  const storageDriverFactory =
    (authorized.container.resolve('storageDriverFactory') as StorageDriverFactory | null) ??
    new StorageDriverFactory(authorized.em)
  const driver = await storageDriverFactory.resolveForPartition(attachment.partitionCode, {
    tenantId: attachment.tenantId ?? '',
    organizationId: attachment.organizationId ?? '',
  })
  try {
    const result = await driver.read(attachment.partitionCode, attachment.storagePath)
    return new NextResponse(new Blob([toArrayBuffer(result.buffer)]), {
      status: 200,
      headers: {
        'Cache-Control': partition.isPublic ? 'public, max-age=86400' : 'private, max-age=60',
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': buildAttachmentContentDisposition(attachment.fileName, 'attachment'),
        'X-Content-Type-Options': 'nosniff',
        ...(attachment.fileSize > 0 ? { 'Content-Length': String(attachment.fileSize) } : {}),
      },
    })
  } catch {
    return NextResponse.json({ ok: false, error: 'File not available' }, { status: 404 })
  }
}

export async function listPortalOrderTimeline(req: Request, id: string): Promise<NextResponse> {
  const authorized = await authorizePortalDocumentRequest(req, 'portal.orders.view')
  if (authorized instanceof Response) return authorized as NextResponse

  const loaded = await loadPortalOrderForRequest(authorized, id)
  if (loaded instanceof Response) return loaded as NextResponse

  const actionLogService = authorized.container.resolve('actionLogService') as ActionLogService
  const [actionLogList, notes] = await Promise.all([
    actionLogService.list({
      tenantId: authorized.auth.tenantId,
      organizationId: authorized.auth.orgId,
      resourceKind: 'sales.order',
      resourceId: id,
      includeRelated: true,
      limit: 50,
    }),
    findWithDecryption(
      authorized.em,
      SalesNote,
      {
        contextType: 'order',
        contextId: id,
        tenantId: authorized.auth.tenantId,
        organizationId: authorized.auth.orgId,
        deletedAt: null,
        appearanceIcon: { $in: ['check-circle', 'message-circle'] },
      },
      { orderBy: { createdAt: 'DESC' } },
      { tenantId: authorized.auth.tenantId, organizationId: authorized.auth.orgId },
    ),
  ])
  const entries = buildHistoryEntries({
    actionLogs: actionLogList.items as ActionLog[],
    notes,
    kind: 'order',
    displayUsers: {
      [authorized.auth.sub]: authorized.auth.displayName || authorized.auth.email || 'Customer',
    },
  }).slice(0, 50)

  return NextResponse.json({
    ok: true,
    timeline: entries.map((entry) => ({
      id: entry.id,
      occurredAt: entry.occurredAt,
      kind: entry.kind,
      action: entry.action,
      actor: entry.actor,
    })),
  })
}

function mapComment(note: SalesNote, auth: CustomerAuthContext) {
  const isCustomer = note.authorUserId === auth.sub
  return {
    id: note.id,
    body: note.body,
    authorName: isCustomer ? auth.displayName || null : null,
    authorEmail: isCustomer ? auth.email || null : null,
    createdAt: serializeDate(note.createdAt) ?? new Date(0).toISOString(),
  }
}

export async function listPortalQuoteComments(req: Request, id: string): Promise<NextResponse> {
  const authorized = await authorizePortalDocumentRequest(req, 'portal.quotes.view')
  if (authorized instanceof Response) return authorized as NextResponse

  const loaded = await loadPortalQuoteForRequest(authorized, id)
  if (loaded instanceof Response) return loaded as NextResponse

  const notes = await findWithDecryption(
    authorized.em,
    SalesNote,
    {
      contextType: 'quote',
      contextId: id,
      tenantId: authorized.auth.tenantId,
      organizationId: authorized.auth.orgId,
      deletedAt: null,
      appearanceIcon: 'message-circle',
    },
    { orderBy: { createdAt: 'ASC' } },
    { tenantId: authorized.auth.tenantId, organizationId: authorized.auth.orgId },
  )

  return NextResponse.json({ ok: true, comments: notes.map((note) => mapComment(note, authorized.auth)) })
}

export async function createPortalQuoteComment(req: Request, id: string): Promise<NextResponse> {
  try {
    const authorized = await authorizePortalDocumentRequest(req, 'portal.quotes.view')
    if (authorized instanceof Response) return authorized as NextResponse

    try {
      await requireCustomerFeature(authorized.auth, ['portal.quotes.comment'], authorized.customerRbacService)
    } catch (response) {
      return response instanceof Response
        ? response as NextResponse
        : NextResponse.json({ ok: false, error: 'Insufficient permissions' }, { status: 403 })
    }

    const loaded = await loadPortalQuoteForRequest(authorized, id)
    if (loaded instanceof Response) return loaded as NextResponse

    const parsed = portalCommentSchema.safeParse(await req.json().catch(() => ({})))
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: 'Comment is required' }, { status: 400 })
    }

    const now = new Date()
    const note = authorized.em.create(SalesNote, {
      tenantId: authorized.auth.tenantId,
      organizationId: authorized.auth.orgId,
      contextType: 'quote',
      contextId: id,
      quote: loaded.quote,
      authorUserId: authorized.auth.sub,
      appearanceIcon: 'message-circle',
      appearanceColor: 'blue',
      body: parsed.data.body,
      createdAt: now,
      updatedAt: now,
    })
    authorized.em.persist(note)
    await authorized.em.flush()

    return NextResponse.json({ ok: true, comment: mapComment(note, authorized.auth) })
  } catch (err) {
    console.error('sales.portal.quotes.comments.post failed', err)
    return NextResponse.json({ ok: false, error: 'Failed to add comment' }, { status: 400 })
  }
}

export async function acceptPortalQuote(req: Request, id: string): Promise<NextResponse> {
  try {
    const { translate } = await resolveTranslations()
    const authorized = await authorizePortalDocumentRequest(req, 'portal.quotes.view')
    if (authorized instanceof Response) return authorized as NextResponse

    const customerEntityId = requireCompanyScope(authorized.auth)
    if (customerEntityId instanceof Response) return customerEntityId as NextResponse

    try {
      await requireCustomerFeature(authorized.auth, ['portal.quotes.accept'], authorized.customerRbacService)
    } catch (response) {
      return response instanceof Response
        ? response as NextResponse
        : NextResponse.json({ ok: false, error: 'Insufficient permissions' }, { status: 403 })
    }

    const parsed = acceptPortalQuoteSchema.safeParse(await req.json().catch(() => ({})))
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: translate('sales.portal.quotes.accept.validation', 'Accepting a quote requires your name and terms acceptance.') },
        { status: 400 },
      )
    }

    const scope = { tenantId: authorized.auth.tenantId, organizationId: authorized.auth.orgId }
    const em = authorized.em.fork()
    const { orderId, orderNumber } = await acceptQuoteAndConvertToOrder({
      req,
      container: authorized.container,
      em,
      auth: null,
      scope,
      translate,
      loadQuoteForUpdate: (trx) =>
        findOneWithDecryption(
          trx,
          SalesQuote,
          buildDetailWhere<SalesQuote>(authorized.auth, customerEntityId, id),
          quoteLockOptions(),
          scope,
        ),
      acceptedBy: {
        customerUserId: authorized.auth.sub,
        email: authorized.auth.email,
        displayName: authorized.auth.displayName,
        acceptedByName: parsed.data.acceptedByName,
        acceptedTerms: parsed.data.acceptedTerms,
        source: 'customer_portal',
      },
    })

    return NextResponse.json({ ok: true, orderId, orderNumber })
  } catch (err) {
    if (isCrudHttpError(err)) {
      return NextResponse.json({ ok: false, ...err.body }, { status: err.status })
    }
    const { translate } = await resolveTranslations()
    console.error('sales.portal.quotes.accept failed', err)
    return NextResponse.json(
      { ok: false, error: translate('sales.portal.quotes.accept.error', 'Failed to accept quote.') },
      { status: 400 },
    )
  }
}

const orderResponseSchema = z.object({
  ok: z.literal(true),
  orders: z.array(orderSchema),
  total: z.number(),
  totalPages: z.number(),
  page: z.number(),
  pageSize: z.number(),
})

const quoteResponseSchema = z.object({
  ok: z.literal(true),
  quotes: z.array(quoteSchema),
  total: z.number(),
  totalPages: z.number(),
  page: z.number(),
  pageSize: z.number(),
})

const orderDetailResponseSchema = z.object({
  ok: z.literal(true),
  order: orderDetailSchema,
})

const quoteDetailResponseSchema = z.object({
  ok: z.literal(true),
  quote: quoteDetailSchema,
})

const quoteAcceptResponseSchema = z.object({
  ok: z.literal(true),
  orderId: z.string().uuid(),
  orderNumber: z.string(),
})

const attachmentsResponseSchema = z.object({
  ok: z.literal(true),
  attachments: z.array(attachmentSchema),
})

const timelineResponseSchema = z.object({
  ok: z.literal(true),
  timeline: z.array(timelineEntrySchema),
})

const commentsResponseSchema = z.object({
  ok: z.literal(true),
  comments: z.array(commentSchema),
})

const commentCreateResponseSchema = z.object({
  ok: z.literal(true),
  comment: commentSchema,
})

function buildGetMethodDoc(summary: string, description: string, schema: z.ZodTypeAny): OpenApiMethodDoc {
  return {
    summary,
    description,
    tags: ['Customer Portal', 'Sales'],
    query: querySchema,
    responses: [{ status: 200, description: summary, schema }],
    errors: [
      { status: 401, description: 'Not authenticated', schema: errorSchema },
      { status: 403, description: 'Insufficient permissions or no company association', schema: errorSchema },
    ],
  }
}

function buildDetailGetMethodDoc(summary: string, description: string, schema: z.ZodTypeAny): OpenApiMethodDoc {
  return {
    summary,
    description,
    tags: ['Customer Portal', 'Sales'],
    responses: [{ status: 200, description: summary, schema }],
    errors: [
      { status: 401, description: 'Not authenticated', schema: errorSchema },
      { status: 403, description: 'Insufficient permissions or no company association', schema: errorSchema },
      { status: 404, description: 'Document not found', schema: errorSchema },
    ],
  }
}

export const portalOrdersOpenApi: OpenApiRouteDoc = {
  summary: 'List portal orders',
  methods: {
    GET: buildGetMethodDoc(
      'List portal orders',
      'Lists orders for the authenticated customer portal user company.',
      orderResponseSchema,
    ),
  },
}

export const portalQuotesOpenApi: OpenApiRouteDoc = {
  summary: 'List portal quotes',
  methods: {
    GET: buildGetMethodDoc(
      'List portal quotes',
      'Lists quotes for the authenticated customer portal user company.',
      quoteResponseSchema,
    ),
  },
}

export const portalOrderDetailOpenApi: OpenApiRouteDoc = {
  summary: 'Read portal order',
  methods: {
    GET: buildDetailGetMethodDoc(
      'Read portal order',
      'Reads an order and its line items for the authenticated customer portal user company.',
      orderDetailResponseSchema,
    ),
  },
}

export const portalQuoteDetailOpenApi: OpenApiRouteDoc = {
  summary: 'Read portal quote',
  methods: {
    GET: buildDetailGetMethodDoc(
      'Read portal quote',
      'Reads a quote and its line items for the authenticated customer portal user company.',
      quoteDetailResponseSchema,
    ),
  },
}

export const portalQuoteAcceptOpenApi: OpenApiRouteDoc = {
  summary: 'Accept portal quote',
  methods: {
    POST: {
      summary: 'Accept portal quote',
      description: 'Accepts a quote for the authenticated customer company and converts it to an order.',
      tags: ['Customer Portal', 'Sales'],
      responses: [{ status: 200, description: 'Quote accepted and order created', schema: quoteAcceptResponseSchema }],
      errors: [
        { status: 400, description: 'Quote cannot be accepted', schema: errorSchema },
        { status: 401, description: 'Not authenticated', schema: errorSchema },
        { status: 403, description: 'Insufficient permissions or no company association', schema: errorSchema },
        { status: 404, description: 'Quote not found', schema: errorSchema },
      ],
    },
  },
}

export const portalOrderPdfOpenApi: OpenApiRouteDoc = {
  summary: 'Download portal order PDF',
  methods: {
    GET: buildDetailGetMethodDoc(
      'Download portal order PDF',
      'Generates a PDF for an order that belongs to the authenticated customer portal user company.',
      z.any(),
    ),
  },
}

export const portalQuotePdfOpenApi: OpenApiRouteDoc = {
  summary: 'Download portal quote PDF',
  methods: {
    GET: buildDetailGetMethodDoc(
      'Download portal quote PDF',
      'Generates a PDF for a quote that belongs to the authenticated customer portal user company.',
      z.any(),
    ),
  },
}

export const portalOrderAttachmentsOpenApi: OpenApiRouteDoc = {
  summary: 'List portal order attachments',
  methods: {
    GET: buildDetailGetMethodDoc(
      'List portal order attachments',
      'Lists attachments for an order that belongs to the authenticated customer portal user company.',
      attachmentsResponseSchema,
    ),
  },
}

export const portalQuoteAttachmentsOpenApi: OpenApiRouteDoc = {
  summary: 'List portal quote attachments',
  methods: {
    GET: buildDetailGetMethodDoc(
      'List portal quote attachments',
      'Lists attachments for a quote that belongs to the authenticated customer portal user company.',
      attachmentsResponseSchema,
    ),
  },
}

export const portalOrderAttachmentDownloadOpenApi: OpenApiRouteDoc = {
  summary: 'Download portal order attachment',
  methods: {
    GET: buildDetailGetMethodDoc(
      'Download portal order attachment',
      'Downloads a scoped order attachment for the authenticated customer portal user company.',
      z.any(),
    ),
  },
}

export const portalQuoteAttachmentDownloadOpenApi: OpenApiRouteDoc = {
  summary: 'Download portal quote attachment',
  methods: {
    GET: buildDetailGetMethodDoc(
      'Download portal quote attachment',
      'Downloads a scoped quote attachment for the authenticated customer portal user company.',
      z.any(),
    ),
  },
}

export const portalOrderTimelineOpenApi: OpenApiRouteDoc = {
  summary: 'List portal order timeline',
  methods: {
    GET: buildDetailGetMethodDoc(
      'List portal order timeline',
      'Lists customer-safe order timeline entries for the authenticated customer portal user company.',
      timelineResponseSchema,
    ),
  },
}

export const portalQuoteCommentsOpenApi: OpenApiRouteDoc = {
  summary: 'List and create portal quote comments',
  methods: {
    GET: buildDetailGetMethodDoc(
      'List portal quote comments',
      'Lists customer-visible quote comments for the authenticated customer portal user company.',
      commentsResponseSchema,
    ),
    POST: {
      summary: 'Create portal quote comment',
      description: 'Creates a customer-visible comment on a quote for the authenticated customer company.',
      tags: ['Customer Portal', 'Sales'],
      responses: [{ status: 200, description: 'Quote comment created', schema: commentCreateResponseSchema }],
      errors: [
        { status: 400, description: 'Invalid comment', schema: errorSchema },
        { status: 401, description: 'Not authenticated', schema: errorSchema },
        { status: 403, description: 'Insufficient permissions or no company association', schema: errorSchema },
        { status: 404, description: 'Quote not found', schema: errorSchema },
      ],
    },
  },
}
