import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager, EntityName, FilterQuery, FindOptions } from '@mikro-orm/postgresql'
import type { OpenApiMethodDoc, OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { getCustomerAuthFromRequest, requireCustomerFeature } from '@open-mercato/core/modules/customer_accounts/lib/customerAuth'
import type { CustomerAuthContext } from '@open-mercato/core/modules/customer_accounts/lib/customerAuth'
import type { CustomerRbacService } from '@open-mercato/core/modules/customer_accounts/services/customerRbacService'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { findAndCountWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { buildIlikeTerm } from '@open-mercato/shared/lib/db/buildIlikeTerm'
import { SalesOrder, SalesQuote } from '../../data/entities'

type PortalDocumentKind = 'orders' | 'quotes'

type PortalDocumentConfig<Entity extends SalesOrder | SalesQuote> = {
  kind: PortalDocumentKind
  entity: EntityName<Entity>
  feature: string
  numberField: keyof Entity & string
  responseKey: PortalDocumentKind
}

const querySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).optional(),
  search: z.string().trim().optional(),
})

type PortalDocumentQuery = z.infer<typeof querySchema>

const errorSchema = z.object({ ok: z.literal(false), error: z.string() })

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
): Promise<{ auth: CustomerAuthContext; em: EntityManager } | NextResponse> {
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
  return { auth, em }
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
