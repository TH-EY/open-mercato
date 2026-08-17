/** @jest-environment node */

import { NextResponse } from 'next/server'

const mockCreateStaffRequestContext = jest.fn()
const mockLoadEligibleIntermediaryUsers = jest.fn()

jest.mock('../lib/http', () => ({
  createStaffRequestContext: (...args: unknown[]) => mockCreateStaffRequestContext(...args),
  routeErrorResponse: (error: unknown) => NextResponse.json({ error: String(error) }, { status: 500 }),
  unauthorizedResponse: () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
}))

jest.mock('../lib/access', () => ({
  loadEligibleIntermediaryUsers: (...args: unknown[]) => mockLoadEligibleIntermediaryUsers(...args),
}))

describe('intermediary picker compatibility', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCreateStaffRequestContext.mockResolvedValue({
      em: {},
      tenantId: '11111111-1111-4111-8111-111111111111',
      organizationId: '22222222-2222-4222-8222-222222222222',
    })
    mockLoadEligibleIntermediaryUsers.mockResolvedValue({
      role: { id: '33333333-3333-4333-8333-333333333333' },
      users: [
        { id: '44444444-4444-4444-8444-444444444444', displayName: 'Zed Example', email: 'zed@example.com' },
        { id: '55555555-5555-4555-8555-555555555555', displayName: 'Amy Example', email: 'amy@example.com' },
      ],
    })
  })

  it('preserves the route, feature gate, wrapper, and exact item fields', async () => {
    const route = await import('../api/admin/intermediaries/route')
    const response = await route.GET(new Request(
      'http://localhost/api/finoo_intermediaries/admin/intermediaries?pageSize=1',
    ))

    expect(route.metadata.GET.requireFeatures).toEqual(['finoo_intermediaries.manage'])
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      items: [{
        id: '55555555-5555-4555-8555-555555555555',
        displayName: 'Amy Example',
        email: 'amy@example.com',
      }],
    })
    expect(mockLoadEligibleIntermediaryUsers).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tenantId: '11111111-1111-4111-8111-111111111111',
        organizationId: '22222222-2222-4222-8222-222222222222',
      }),
    )
  })

  it('keeps case-insensitive display-name and email search after eligibility filtering', async () => {
    const route = await import('../api/admin/intermediaries/route')
    const response = await route.GET(new Request(
      'http://localhost/api/finoo_intermediaries/admin/intermediaries?query=ZED%40EXAMPLE.COM&pageSize=100',
    ))

    expect(await response.json()).toEqual({
      items: [{
        id: '44444444-4444-4444-8444-444444444444',
        displayName: 'Zed Example',
        email: 'zed@example.com',
      }],
    })
  })
})
