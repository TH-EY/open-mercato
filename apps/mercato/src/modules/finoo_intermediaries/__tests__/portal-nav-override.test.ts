import type { EntityManager } from '@mikro-orm/postgresql'

const mockCoreNavGet = jest.fn()
const mockGetCustomerAuthFromRequest = jest.fn()
const mockCreateRequestContainer = jest.fn()

jest.mock('@open-mercato/core/modules/customer_accounts/api/portal/nav', () => ({
  GET: (...args: unknown[]) => mockCoreNavGet(...args),
}))

jest.mock('@open-mercato/core/modules/customer_accounts/lib/customerAuth', () => ({
  getCustomerAuthFromRequest: (...args: unknown[]) => mockGetCustomerAuthFromRequest(...args),
}))

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: (...args: unknown[]) => mockCreateRequestContainer(...args),
}))

import { GET } from '../overrides/portalNav'

const auth = {
  sub: '33333333-3333-4333-8333-333333333333',
  tenantId: '11111111-1111-4111-8111-111111111111',
  orgId: '22222222-2222-4222-8222-222222222222',
}

const navPayload = {
  ok: true,
  orgSlug: 'finoo',
  groups: [
    {
      id: 'main',
      items: [
        { id: 'dashboard', href: '/finoo/portal/dashboard', label: 'Dashboard' },
        { id: 'assigned-deals', href: '/finoo/portal/intermediary/deals', label: 'Assigned deals' },
      ],
    },
  ],
  grantedFeatures: ['portal.finoo_intermediaries.view'],
  isPortalAdmin: false,
}

describe('finoo_intermediaries portal nav override', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCoreNavGet.mockResolvedValue(Response.json(navPayload))
    mockGetCustomerAuthFromRequest.mockResolvedValue(auth)
  })

  it('removes Dashboard for an exact intermediary role membership', async () => {
    const em = {
      find: jest.fn(async () => [{ id: '44444444-4444-4444-8444-444444444444' }]),
      findOne: jest.fn(async () => ({ id: '55555555-5555-4555-8555-555555555555' })),
    } as unknown as EntityManager
    mockCreateRequestContainer.mockResolvedValue({ resolve: () => em })

    const response = await GET(new Request('https://finoo.test/api/customer_accounts/portal/nav'))

    await expect(response.json()).resolves.toMatchObject({
      groups: [{ items: [{ href: '/finoo/portal/intermediary/deals' }] }],
    })
  })

  it('uses exact role membership even when the portal feature configuration is missing', async () => {
    mockCoreNavGet.mockResolvedValue(Response.json({
      ...navPayload,
      grantedFeatures: [],
    }))
    const em = {
      find: jest.fn(async () => [{ id: '44444444-4444-4444-8444-444444444444' }]),
      findOne: jest.fn(async () => ({ id: '55555555-5555-4555-8555-555555555555' })),
    } as unknown as EntityManager
    mockCreateRequestContainer.mockResolvedValue({ resolve: () => em })

    const response = await GET(new Request('https://finoo.test/api/customer_accounts/portal/nav'))

    await expect(response.json()).resolves.toMatchObject({
      groups: [{ items: [{ href: '/finoo/portal/intermediary/deals' }] }],
    })
  })

  it('returns the core navigation unchanged for a non-intermediary', async () => {
    const em = {
      find: jest.fn(async () => []),
      findOne: jest.fn(),
    } as unknown as EntityManager
    mockCreateRequestContainer.mockResolvedValue({ resolve: () => em })

    const response = await GET(new Request('https://finoo.test/api/customer_accounts/portal/nav'))

    await expect(response.json()).resolves.toEqual(navPayload)
  })
})
