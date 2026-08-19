/** @jest-environment node */

import { signAudienceJwt } from '@open-mercato/shared/lib/auth/jwt'

const mockCookies = jest.fn()
const mockFindActiveSessionForClaims = jest.fn()
const mockValidateUserState = jest.fn()

jest.mock('next/headers', () => ({
  cookies: (...args: unknown[]) => mockCookies(...args),
}))

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: jest.fn(async () => ({
    resolve: (name: string) => {
      if (name === 'customerSessionService') {
        return { findActiveSessionForClaims: mockFindActiveSessionForClaims }
      }
      return null
    },
  })),
}))

jest.mock('@open-mercato/core/modules/customer_accounts/lib/customerAuth', () => ({
  validateUserState: (...args: unknown[]) => mockValidateUserState(...args),
}))

const tenantId = '11111111-1111-4111-8111-111111111111'
const orgA = '22222222-2222-4222-8222-222222222222'
const orgB = '33333333-3333-4333-8333-333333333333'
const userId = '44444444-4444-4444-8444-444444444444'
const sessionId = '55555555-5555-4555-8555-555555555555'

function customerToken(orgId: string): string {
  return signAudienceJwt('customer', {
    sub: userId,
    sid: sessionId,
    type: 'customer',
    tenantId,
    orgId,
    email: 'customer@example.test',
    displayName: 'Customer User',
  })
}

describe('getCustomerAuthFromCookies', () => {
  beforeAll(() => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-unit-tests'
  })

  beforeEach(() => {
    jest.clearAllMocks()
    mockFindActiveSessionForClaims.mockResolvedValue({ id: sessionId })
    mockValidateUserState.mockResolvedValue({ valid: true, resolvedFeatures: ['portal.dashboard.view'] })
  })

  it('rejects a customer JWT whose organization does not match the route organization', async () => {
    mockCookies.mockResolvedValue({
      get: (name: string) => (name === 'customer_auth_token' ? { value: customerToken(orgB) } : undefined),
    })
    const { getCustomerAuthFromCookies } = await import('../customerAuthServer')

    const auth = await getCustomerAuthFromCookies({
      expectedTenantId: tenantId,
      expectedOrganizationId: orgA,
    })

    expect(auth).toBeNull()
    expect(mockFindActiveSessionForClaims).not.toHaveBeenCalled()
    expect(mockValidateUserState).not.toHaveBeenCalled()
  })

  it('accepts a customer JWT whose tenant and organization match the route', async () => {
    mockCookies.mockResolvedValue({
      get: (name: string) => (name === 'customer_auth_token' ? { value: customerToken(orgA) } : undefined),
    })
    const { getCustomerAuthFromCookies } = await import('../customerAuthServer')

    const auth = await getCustomerAuthFromCookies({
      expectedTenantId: tenantId,
      expectedOrganizationId: orgA,
    })

    expect(auth).toMatchObject({
      sub: userId,
      tenantId,
      orgId: orgA,
    })
    expect(mockFindActiveSessionForClaims).toHaveBeenCalledWith({
      sessionId,
      userId,
      tenantId,
      organizationId: orgA,
    })
    expect(mockValidateUserState).toHaveBeenCalledWith(userId, tenantId, orgA, expect.anything())
  })
})
