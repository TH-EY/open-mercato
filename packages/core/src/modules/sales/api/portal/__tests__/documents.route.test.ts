/** @jest-environment node */
import { SalesOrder, SalesQuote } from '@open-mercato/core/modules/sales/data/entities'

const mockGetCustomerAuth = jest.fn()
const mockRequireCustomerFeature = jest.fn()
const mockEmFindAndCount = jest.fn()

const mockEm = {
  findAndCount: mockEmFindAndCount,
}

const mockContainer = {
  resolve: jest.fn((token: string) => {
    if (token === 'customerRbacService') return {}
    if (token === 'em') return mockEm
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

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findAndCountWithDecryption: (em: any, entity: any, where: any, options?: any) =>
    em.findAndCount(entity, where, options),
}))

import { GET as getPortalOrders } from '@open-mercato/core/modules/sales/api/portal/orders'
import { GET as getPortalQuotes } from '@open-mercato/core/modules/sales/api/portal/quotes'

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

describe('sales portal document list routes', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    setDefaultAuth()
    mockEmFindAndCount.mockResolvedValue([[], 0])
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
})
