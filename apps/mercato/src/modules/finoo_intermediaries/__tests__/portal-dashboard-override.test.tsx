import React from 'react'
import type { EntityManager } from '@mikro-orm/postgresql'

const mockRedirect = jest.fn()
const mockGetCustomerAuthFromCookies = jest.fn()
const mockCreateRequestContainer = jest.fn()
const mockPortalDashboard = jest.fn(() => React.createElement('div', null, 'Core dashboard'))

jest.mock('next/navigation', () => ({
  redirect: (...args: unknown[]) => mockRedirect(...args),
}))

jest.mock('@open-mercato/core/modules/customer_accounts/lib/customerAuthServer', () => ({
  getCustomerAuthFromCookies: (...args: unknown[]) => mockGetCustomerAuthFromCookies(...args),
}))

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: (...args: unknown[]) => mockCreateRequestContainer(...args),
}))

jest.mock('@open-mercato/core/modules/portal/frontend/[orgSlug]/portal/dashboard/page', () => ({
  __esModule: true,
  default: (props: unknown) => mockPortalDashboard(props),
}))

import FinooPortalDashboardPage from '../overrides/portalDashboard'

const auth = {
  sub: '33333333-3333-4333-8333-333333333333',
  tenantId: '11111111-1111-4111-8111-111111111111',
  orgId: '22222222-2222-4222-8222-222222222222',
}

describe('finoo_intermediaries Dashboard page override', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetCustomerAuthFromCookies.mockResolvedValue(auth)
    mockRedirect.mockImplementation((href: string) => {
      throw new Error(`NEXT_REDIRECT:${href}`)
    })
  })

  it('redirects an intermediary directly to Assigned deals', async () => {
    const em = {
      find: jest.fn(async () => [{ id: '44444444-4444-4444-8444-444444444444' }]),
      findOne: jest.fn(async () => ({ id: '55555555-5555-4555-8555-555555555555' })),
    } as unknown as EntityManager
    mockCreateRequestContainer.mockResolvedValue({ resolve: () => em })

    await expect(FinooPortalDashboardPage({ params: { orgSlug: 'finoo' } }))
      .rejects.toThrow('NEXT_REDIRECT:/finoo/portal/intermediary/deals')
    expect(mockPortalDashboard).not.toHaveBeenCalled()
  })

  it('preserves the existing Dashboard for a non-intermediary portal user', async () => {
    const em = {
      find: jest.fn(async () => []),
      findOne: jest.fn(),
    } as unknown as EntityManager
    mockCreateRequestContainer.mockResolvedValue({ resolve: () => em })

    const result = await FinooPortalDashboardPage({ params: { orgSlug: 'finoo' } })

    expect(typeof result.type).toBe('function')
    expect(result.props.params).toEqual({ orgSlug: 'finoo' })
    expect(mockRedirect).not.toHaveBeenCalled()
  })
})
