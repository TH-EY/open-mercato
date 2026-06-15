import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager, EntityName, FilterQuery, FindOptions } from '@mikro-orm/postgresql'
import type { OpenApiMethodDoc, OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { getCustomerAuthFromRequest, requireCustomerFeature } from '@open-mercato/core/modules/customer_accounts/lib/customerAuth'
import type { CustomerAuthContext } from '@open-mercato/core/modules/customer_accounts/lib/customerAuth'
import type { CustomerRbacService } from '@open-mercato/core/modules/customer_accounts/services/customerRbacService'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { findAndCountWithDecryption, findOneWithDecryption, findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { buildIlikeTerm } from '@open-mercato/shared/lib/db/buildIlikeTerm'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { CrudHttpError, isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { SalesOrder, SalesOrderLine, SalesQuote, SalesQuoteLine } from '../../data/entities'
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
  lines: z.array(lineSchema),
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
    lines: lines.map(mapLine),
  }
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

  return NextResponse.json({ ok: true, order: mapOrderDetail(order, lines) })
}

async function getPortalQuote(req: Request, id: string): Promise<NextResponse> {
  const authorized = await authorizePortalDocumentRequest(req, 'portal.quotes.view')
  if (authorized instanceof Response) return authorized as NextResponse

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

  const [lines, hasAcceptFeature] = await Promise.all([
    findWithDecryption(
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
    ),
    hasCustomerFeature(authorized.auth, 'portal.quotes.accept', authorized.customerRbacService),
  ])

  return NextResponse.json({ ok: true, quote: mapQuoteDetail(quote, lines, hasAcceptFeature) })
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
