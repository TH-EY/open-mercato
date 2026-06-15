/** @jest-environment node */
import { SalesNote, SalesOrder, SalesOrderLine, SalesQuote, SalesQuoteLine } from '@open-mercato/core/modules/sales/data/entities'
import { Attachment } from '@open-mercato/core/modules/attachments/data/entities'

const mockGetCustomerAuth = jest.fn()
const mockRequireCustomerFeature = jest.fn()
const mockEmFindAndCount = jest.fn()
const mockEmFindOne = jest.fn()
const mockEmFind = jest.fn()
const mockCommandExecute = jest.fn()
const mockActionLogList = jest.fn()

const mockEm = {
  findAndCount: mockEmFindAndCount,
  findOne: mockEmFindOne,
  find: mockEmFind,
  fork: jest.fn(() => mockEm),
  transactional: jest.fn(async (callback: (trx: typeof mockEm) => Promise<unknown>) => callback(mockEm)),
  create: jest.fn((_entity: unknown, data: unknown) => data),
  persist: jest.fn(),
  flush: jest.fn(async () => undefined),
}

const mockContainer = {
  resolve: jest.fn((token: string) => {
    if (token === 'customerRbacService') return {}
    if (token === 'em') return mockEm
    if (token === 'commandBus') return { execute: mockCommandExecute }
    if (token === 'actionLogService') return { list: mockActionLogList }
    return null
  }),
}

jest.mock('@open-mercato/core/modules/customer_accounts/lib/customerAuth', () => ({
  getCustomerAuthFromRequest: jest.fn((req: Request) => mockGetCustomerAuth(req)),
  requireCustomerFeature: jest.fn((...args: unknown[]) => mockRequireCustomerFeature(...args)),
}))

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: jest.fn(async () => mockContainer),
}))

jest.mock('@open-mercato/shared/lib/i18n/server', () => ({
  resolveTranslations: jest.fn(async () => ({
    translate: (_key: string, fallback: string, values?: Record<string, string | number | null | undefined>) => {
      let output = fallback
      for (const [key, value] of Object.entries(values ?? {})) {
        output = output.replace(new RegExp(`\\{${key}\\}|\\{\\{${key}\\}\\}`, 'g'), String(value ?? ''))
      }
      return output
    },
  })),
}))

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findAndCountWithDecryption: (em: any, entity: any, where: any, options?: any) =>
    em.findAndCount(entity, where, options),
  findOneWithDecryption: (em: any, entity: any, where: any, options?: any) =>
    em.findOne(entity, where, options),
  findWithDecryption: (em: any, entity: any, where: any, options?: any) =>
    em.find(entity, where, options),
}))

jest.mock('@open-mercato/core/modules/sales/lib/statusHelpers', () => ({
  resolveStatusEntryIdByValue: jest.fn(async () => null),
}))

import { GET as getPortalOrders } from '@open-mercato/core/modules/sales/api/portal/orders'
import { GET as getPortalQuotes } from '@open-mercato/core/modules/sales/api/portal/quotes'
import { acceptPortalQuote, getPortalOrderDetail, getPortalQuoteDetail } from '@open-mercato/core/modules/sales/api/portal/documents'

const tenantId = '11111111-1111-4111-8111-111111111111'
const orgId = '22222222-2222-4222-8222-222222222222'
const customerEntityId = '33333333-3333-4333-8333-333333333333'

function setDefaultAuth() {
  mockGetCustomerAuth.mockResolvedValue({
    sub: 'user-1',
    tenantId,
    orgId,
    customerEntityId,
  })
  mockRequireCustomerFeature.mockResolvedValue(undefined)
}

function makeOrder(overrides: Partial<SalesOrder> = {}): SalesOrder {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    tenantId,
    organizationId: orgId,
    orderNumber: 'SO-1',
    status: 'confirmed',
    fulfillmentStatus: 'pending',
    paymentStatus: 'unpaid',
    placedAt: new Date('2026-06-01T00:00:00Z'),
    expectedDeliveryAt: null,
    lineItemCount: 2,
    grandTotalGrossAmount: '120.50',
    outstandingAmount: '120.50',
    currencyCode: 'PLN',
    createdAt: new Date('2026-06-01T00:00:00Z'),
    updatedAt: new Date('2026-06-02T00:00:00Z'),
    ...overrides,
  } as SalesOrder
}

function makeOrderLine(overrides: Partial<SalesOrderLine> = {}): SalesOrderLine {
  return {
    id: '66666666-6666-4666-8666-666666666666',
    lineNumber: 1,
    kind: 'service',
    status: null,
    name: 'ASHP installation',
    description: 'Air source heat pump installation package',
    comment: null,
    quantity: '1',
    quantityUnit: 'package',
    unitPriceNet: '100.00',
    unitPriceGross: '120.00',
    discountAmount: '0',
    taxRate: '20',
    taxAmount: '20.00',
    totalNetAmount: '100.00',
    totalGrossAmount: '120.00',
    currencyCode: 'GBP',
    ...overrides,
  } as SalesOrderLine
}

function makeQuote(overrides: Partial<SalesQuote> = {}): SalesQuote {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    tenantId,
    organizationId: orgId,
    quoteNumber: 'SQ-1',
    status: 'sent',
    validFrom: new Date('2026-06-01T00:00:00Z'),
    validUntil: new Date('2026-06-30T00:00:00Z'),
    convertedOrderId: null,
    lineItemCount: 1,
    grandTotalGrossAmount: '99.00',
    currencyCode: 'PLN',
    createdAt: new Date('2026-06-01T00:00:00Z'),
    updatedAt: new Date('2026-06-02T00:00:00Z'),
    ...overrides,
  } as SalesQuote
}

function makeQuoteLine(overrides: Partial<SalesQuoteLine> = {}): SalesQuoteLine {
  return {
    id: '77777777-7777-4777-8777-777777777777',
    lineNumber: 1,
    kind: 'service',
    status: null,
    name: 'Solar PV installation',
    description: 'Solar PV design, installation and handover',
    comment: null,
    quantity: '1',
    quantityUnit: 'package',
    unitPriceNet: '100.00',
    unitPriceGross: '120.00',
    discountAmount: '0',
    taxRate: '20',
    taxAmount: '20.00',
    totalNetAmount: '100.00',
    totalGrossAmount: '120.00',
    currencyCode: 'GBP',
    ...overrides,
  } as SalesQuoteLine
}

function makeAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: '99999999-9999-4999-8999-999999999999',
    tenantId,
    organizationId: orgId,
    entityId: 'sales:sales_order',
    recordId: '44444444-4444-4444-8444-444444444444',
    partitionCode: 'default',
    fileName: 'proposal.pdf',
    mimeType: 'application/pdf',
    fileSize: 1234,
    storageDriver: 'local',
    storagePath: 'proposal.pdf',
    storageMetadata: null,
    url: '/api/attachments/file/99999999-9999-4999-8999-999999999999',
    content: null,
    createdAt: new Date('2026-06-03T00:00:00Z'),
    ...overrides,
  } as Attachment
}

function makeNote(overrides: Partial<SalesNote> = {}): SalesNote {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    tenantId,
    organizationId: orgId,
    contextType: 'quote',
    contextId: '55555555-5555-4555-8555-555555555555',
    authorUserId: 'user-1',
    appearanceIcon: 'message-circle',
    appearanceColor: 'blue',
    body: 'Can you confirm install timing?',
    createdAt: new Date('2026-06-04T00:00:00Z'),
    updatedAt: new Date('2026-06-04T00:00:00Z'),
    deletedAt: null,
    ...overrides,
  } as SalesNote
}

describe('sales portal document list routes', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    setDefaultAuth()
    mockEmFindAndCount.mockResolvedValue([[], 0])
    mockEmFindOne.mockResolvedValue(null)
    mockEmFind.mockResolvedValue([])
    mockCommandExecute.mockResolvedValue({ result: { orderId: '88888888-8888-4888-8888-888888888888' } })
    mockActionLogList.mockResolvedValue({ items: [] })
  })

  it('returns 401 when the customer is not authenticated', async () => {
    mockGetCustomerAuth.mockResolvedValue(null)

    const res = await getPortalOrders(new Request('http://localhost/api/sales/portal/orders'))
    const body = await res.json()

    expect(res.status).toBe(401)
    expect(body).toMatchObject({ ok: false })
    expect(mockEmFindAndCount).not.toHaveBeenCalled()
  })

  it('returns 403 when the customer lacks the required portal feature', async () => {
    mockRequireCustomerFeature.mockRejectedValue(
      Response.json({ ok: false, error: 'Insufficient permissions' }, { status: 403 }),
    )

    const res = await getPortalQuotes(new Request('http://localhost/api/sales/portal/quotes'))

    expect(res.status).toBe(403)
    expect(mockRequireCustomerFeature).toHaveBeenCalledWith(
      expect.objectContaining({ sub: 'user-1' }),
      ['portal.quotes.view'],
      {},
    )
    expect(mockEmFindAndCount).not.toHaveBeenCalled()
  })

  it('returns 403 when the customer user is not linked to a company', async () => {
    mockGetCustomerAuth.mockResolvedValue({
      sub: 'user-1',
      tenantId,
      orgId,
      customerEntityId: null,
    })

    const res = await getPortalOrders(new Request('http://localhost/api/sales/portal/orders'))
    const body = await res.json()

    expect(res.status).toBe(403)
    expect(body).toMatchObject({ ok: false, error: 'No company association' })
    expect(mockEmFindAndCount).not.toHaveBeenCalled()
  })

  it('lists only orders for the authenticated customer company scope', async () => {
    mockEmFindAndCount.mockResolvedValue([[makeOrder()], 1])

    const res = await getPortalOrders(new Request('http://localhost/api/sales/portal/orders?page=2&pageSize=500&search=SO-1'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(mockRequireCustomerFeature).toHaveBeenCalledWith(
      expect.objectContaining({ sub: 'user-1' }),
      ['portal.orders.view'],
      {},
    )
    expect(mockEmFindAndCount).toHaveBeenCalledWith(
      SalesOrder,
      {
        tenantId,
        organizationId: orgId,
        customerEntityId,
        deletedAt: null,
        orderNumber: { $ilike: '%SO-1%' },
      },
      expect.objectContaining({ limit: 100, offset: 100 }),
    )
    expect(body).toMatchObject({
      ok: true,
      total: 1,
      totalPages: 1,
      page: 2,
      pageSize: 100,
      orders: [{ orderNumber: 'SO-1', fulfillmentStatus: 'pending', paymentStatus: 'unpaid' }],
    })
  })

  it('lists only quotes for the authenticated customer company scope', async () => {
    mockEmFindAndCount.mockResolvedValue([[makeQuote()], 1])

    const res = await getPortalQuotes(new Request('http://localhost/api/sales/portal/quotes?search=SQ-1'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(mockEmFindAndCount).toHaveBeenCalledWith(
      SalesQuote,
      {
        tenantId,
        organizationId: orgId,
        customerEntityId,
        deletedAt: null,
        quoteNumber: { $ilike: '%SQ-1%' },
      },
      expect.objectContaining({ limit: 25, offset: 0 }),
    )
    expect(body).toMatchObject({
      ok: true,
      total: 1,
      totalPages: 1,
      page: 1,
      pageSize: 25,
      quotes: [{ quoteNumber: 'SQ-1', status: 'sent' }],
    })
  })

  it('reads an order detail with line items inside the authenticated company scope', async () => {
    mockEmFindOne.mockResolvedValue(makeOrder())
    mockEmFind.mockResolvedValue([makeOrderLine()])

    const res = await getPortalOrderDetail(
      new Request('http://localhost/api/sales/portal/orders/44444444-4444-4444-8444-444444444444'),
      '44444444-4444-4444-8444-444444444444',
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(mockEmFindOne).toHaveBeenCalledWith(
      SalesOrder,
      expect.objectContaining({
        id: '44444444-4444-4444-8444-444444444444',
        tenantId,
        organizationId: orgId,
        customerEntityId,
        deletedAt: null,
      }),
      expect.any(Object),
    )
    expect(mockEmFind).toHaveBeenCalledWith(
      SalesOrderLine,
      expect.objectContaining({
        order: '44444444-4444-4444-8444-444444444444',
        tenantId,
        organizationId: orgId,
        deletedAt: null,
      }),
      expect.any(Object),
    )
    expect(body.order.lines).toHaveLength(1)
    expect(body.order.lines[0]).toMatchObject({ name: 'ASHP installation' })
  })

  it('returns 404 for a direct order detail outside the company scope', async () => {
    mockEmFindOne.mockResolvedValue(null)

    const res = await getPortalOrderDetail(
      new Request('http://localhost/api/sales/portal/orders/99999999-9999-4999-8999-999999999999'),
      '99999999-9999-4999-8999-999999999999',
    )
    const body = await res.json()

    expect(res.status).toBe(404)
    expect(body).toMatchObject({ ok: false })
  })

  it('reads quote detail and reports acceptability when the customer can accept quotes', async () => {
    mockEmFindOne.mockResolvedValue(makeQuote({ status: 'sent' }))
    mockEmFind.mockResolvedValue([makeQuoteLine()])

    const res = await getPortalQuoteDetail(
      new Request('http://localhost/api/sales/portal/quotes/55555555-5555-4555-8555-555555555555'),
      '55555555-5555-4555-8555-555555555555',
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(mockRequireCustomerFeature).toHaveBeenCalledWith(
      expect.objectContaining({ sub: 'user-1' }),
      ['portal.quotes.accept'],
      {},
    )
    expect(body.quote).toMatchObject({
      quoteNumber: 'SQ-1',
      canAccept: true,
      acceptanceBlockedReason: null,
    })
    expect(body.quote.lines).toHaveLength(1)
  })

  it('generates an order PDF inside the authenticated company scope', async () => {
    const { getPortalDocumentPdf } = await import('@open-mercato/core/modules/sales/api/portal/documents')
    mockEmFindOne.mockResolvedValue(makeOrder())
    mockEmFind.mockResolvedValue([makeOrderLine()])

    const res = await getPortalDocumentPdf(
      new Request('http://localhost/api/sales/portal/orders/44444444-4444-4444-8444-444444444444/pdf'),
      'orders',
      '44444444-4444-4444-8444-444444444444',
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(mockEmFindOne).toHaveBeenCalledWith(
      SalesOrder,
      expect.objectContaining({
        id: '44444444-4444-4444-8444-444444444444',
        tenantId,
        organizationId: orgId,
        customerEntityId,
      }),
      expect.any(Object),
    )
  })

  it('lists order attachments only after the document scope check passes', async () => {
    const { listPortalDocumentAttachments } = await import('@open-mercato/core/modules/sales/api/portal/documents')
    mockEmFindOne.mockResolvedValue(makeOrder())
    mockEmFind.mockImplementation((entity: unknown) => {
      if (entity === SalesOrderLine) return Promise.resolve([makeOrderLine()])
      if (entity === Attachment) return Promise.resolve([makeAttachment()])
      return Promise.resolve([])
    })

    const res = await listPortalDocumentAttachments(
      new Request('http://localhost/api/sales/portal/orders/44444444-4444-4444-8444-444444444444/attachments'),
      'orders',
      '44444444-4444-4444-8444-444444444444',
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(mockEmFind).toHaveBeenCalledWith(
      Attachment,
      expect.objectContaining({
        tenantId,
        organizationId: orgId,
        entityId: 'sales:sales_order',
        recordId: '44444444-4444-4444-8444-444444444444',
      }),
      expect.any(Object),
    )
    expect(body.attachments[0]).toMatchObject({
      fileName: 'proposal.pdf',
      downloadUrl: '/api/sales/portal/orders/44444444-4444-4444-8444-444444444444/attachments/99999999-9999-4999-8999-999999999999?download=1',
    })
  })

  it('creates a quote comment only with the comment feature', async () => {
    const { createPortalQuoteComment } = await import('@open-mercato/core/modules/sales/api/portal/documents')
    mockEmFindOne.mockResolvedValue(makeQuote())
    mockEmFind.mockResolvedValue([makeQuoteLine()])

    const res = await createPortalQuoteComment(
      new Request('http://localhost/api/sales/portal/quotes/55555555-5555-4555-8555-555555555555/comments', {
        method: 'POST',
        body: JSON.stringify({ body: 'Can you confirm install timing?' }),
      }),
      '55555555-5555-4555-8555-555555555555',
    )

    expect(res.status).toBe(200)
    expect(mockRequireCustomerFeature).toHaveBeenCalledWith(
      expect.objectContaining({ sub: 'user-1' }),
      ['portal.quotes.comment'],
      {},
    )
    expect(mockEm.create).toHaveBeenCalledWith(
      SalesNote,
      expect.objectContaining({
        contextType: 'quote',
        appearanceIcon: 'message-circle',
        body: 'Can you confirm install timing?',
      }),
    )
  })

  it('lists an order timeline with portal-visible notes', async () => {
    const { listPortalOrderTimeline } = await import('@open-mercato/core/modules/sales/api/portal/documents')
    mockEmFindOne.mockResolvedValue(makeOrder())
    mockEmFind.mockImplementation((entity: unknown) => {
      if (entity === SalesOrderLine) return Promise.resolve([makeOrderLine()])
      if (entity === SalesNote) return Promise.resolve([makeNote({
        contextType: 'order',
        contextId: '44444444-4444-4444-8444-444444444444',
      })])
      return Promise.resolve([])
    })

    const res = await listPortalOrderTimeline(
      new Request('http://localhost/api/sales/portal/orders/44444444-4444-4444-8444-444444444444/timeline'),
      '44444444-4444-4444-8444-444444444444',
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(mockActionLogList).toHaveBeenCalledWith(expect.objectContaining({
      tenantId,
      organizationId: orgId,
      resourceKind: 'sales.order',
      resourceId: '44444444-4444-4444-8444-444444444444',
    }))
    expect(body.timeline[0]).toMatchObject({ kind: 'comment', action: 'Can you confirm install timing?' })
  })

  it('blocks portal quote acceptance without the accept feature', async () => {
    mockRequireCustomerFeature
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(Response.json({ ok: false, error: 'Insufficient permissions' }, { status: 403 }))

    const res = await acceptPortalQuote(
      new Request('http://localhost/api/sales/portal/quotes/55555555-5555-4555-8555-555555555555/accept', { method: 'POST' }),
      '55555555-5555-4555-8555-555555555555',
    )

    expect(res.status).toBe(403)
    expect(mockCommandExecute).not.toHaveBeenCalled()
  })

  it('requires signer name and terms for portal quote acceptance', async () => {
    const res = await acceptPortalQuote(
      new Request('http://localhost/api/sales/portal/quotes/55555555-5555-4555-8555-555555555555/accept', { method: 'POST' }),
      '55555555-5555-4555-8555-555555555555',
    )
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body).toMatchObject({ ok: false })
    expect(mockCommandExecute).not.toHaveBeenCalled()
  })

  it('accepts a portal quote and converts it to an order atomically', async () => {
    const acceptedOrderId = '88888888-8888-4888-8888-888888888888'
    const quote = makeQuote({ status: 'sent', convertedOrderId: null })
    const order = makeOrder({ id: acceptedOrderId, orderNumber: 'SO-ACCEPT' })
    mockEmFindOne.mockImplementation((entity: unknown) => {
      if (entity === SalesQuote) return Promise.resolve(quote)
      if (entity === SalesOrder) return Promise.resolve(order)
      return Promise.resolve(null)
    })
    mockCommandExecute.mockResolvedValue({ result: { orderId: acceptedOrderId } })

    const res = await acceptPortalQuote(
      new Request('http://localhost/api/sales/portal/quotes/55555555-5555-4555-8555-555555555555/accept', {
        method: 'POST',
        body: JSON.stringify({ acceptedByName: 'Alex Green', acceptedTerms: true }),
      }),
      '55555555-5555-4555-8555-555555555555',
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({ ok: true, orderId: acceptedOrderId, orderNumber: 'SO-ACCEPT' })
    expect(mockCommandExecute).toHaveBeenCalledWith(
      'sales.quotes.convert_to_order',
      expect.objectContaining({
        input: { quoteId: quote.id },
      }),
    )
    expect(quote.status).toBe('confirmed')
    expect(quote.metadata).toMatchObject({
      portalAcceptance: {
        source: 'customer_portal',
        acceptedByName: 'Alex Green',
        acceptedTerms: true,
      },
    })
    expect(order.metadata).toMatchObject({
      portalAcceptance: {
        acceptedByName: 'Alex Green',
        acceptedTerms: true,
      },
    })
    expect(mockEm.create).toHaveBeenCalledWith(
      SalesNote,
      expect.objectContaining({
        contextType: 'quote',
        appearanceIcon: 'check-circle',
      }),
    )
  })
})
