/** @jest-environment node */

const mockGetAuth = jest.fn()
const mockCreateInvitation = jest.fn()
const mockRbac = { userHasAllFeatures: jest.fn() }
const mockContainer = {
  resolve: jest.fn((token: string) => {
    if (token === 'rbacService') return mockRbac
    if (token === 'customerInvitationService') {
      return {
        createInvitation: mockCreateInvitation,
      }
    }
    return null
  }),
}

jest.mock('@open-mercato/shared/lib/auth/server', () => ({
  getAuthFromRequest: jest.fn((req: Request) => mockGetAuth(req)),
}))

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: jest.fn(async () => mockContainer),
}))

jest.mock('@open-mercato/shared/lib/ratelimit/helpers', () => ({
  rateLimitErrorSchema: {},
}))

jest.mock('@open-mercato/core/modules/customer_accounts/lib/rateLimiter', () => ({
  checkAuthRateLimit: jest.fn(async () => ({ error: null, compoundKey: null })),
  customerInviteRateLimitConfig: {},
  customerInviteIpRateLimitConfig: {},
}))

jest.mock('@open-mercato/core/modules/customer_accounts/lib/rateLimitIdentifier', () => ({
  readNormalizedEmailFromJsonRequest: jest.fn(async () => 'invite@example.com'),
}))

import { POST } from '@open-mercato/core/modules/customer_accounts/api/admin/users-invite'

const tenantId = '11111111-1111-4111-8111-111111111111'
const orgId = '22222222-2222-4222-8222-222222222222'
const adminId = '33333333-3333-4333-8333-333333333333'
const apiKeyId = '44444444-4444-4444-8444-444444444444'
const roleId = '55555555-5555-4555-8555-555555555555'

function buildInviteRequest(email = 'invite@example.com') {
  return new Request('http://localhost/api/customer_accounts/admin/users-invite', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      roleIds: [roleId],
      displayName: 'Invited User',
    }),
  })
}

function mockInvitation(email = 'invite@example.com') {
  return {
    invitation: {
      id: '66666666-6666-4666-8666-666666666666',
      email,
      expiresAt: new Date('2026-01-04T00:00:00Z'),
    },
    rawToken: 'raw-token',
  }
}

describe('admin /api/customer_accounts/admin/users-invite — API key auth', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockRbac.userHasAllFeatures.mockResolvedValue(true)
    mockCreateInvitation.mockResolvedValue(mockInvitation())
  })

  it('stores the linked user id as inviter when an API key has an owning user', async () => {
    mockGetAuth.mockResolvedValue({
      sub: `api_key:${apiKeyId}`,
      keyId: apiKeyId,
      userId: adminId,
      tenantId,
      orgId,
      isApiKey: true,
    })

    const res = await POST(buildInviteRequest())

    expect(res.status).toBe(201)
    expect(mockRbac.userHasAllFeatures).toHaveBeenCalledWith(
      `api_key:${apiKeyId}`,
      ['customer_accounts.invite'],
      { tenantId, organizationId: orgId },
    )
    expect(mockCreateInvitation).toHaveBeenCalledWith(
      'invite@example.com',
      { tenantId, organizationId: orgId },
      expect.objectContaining({
        invitedByUserId: adminId,
        roleIds: [roleId],
      }),
    )
  })

  it('stores no user inviter for machine-only API keys', async () => {
    mockGetAuth.mockResolvedValue({
      sub: `api_key:${apiKeyId}`,
      keyId: apiKeyId,
      tenantId,
      orgId,
      isApiKey: true,
    })

    const res = await POST(buildInviteRequest())

    expect(res.status).toBe(201)
    expect(mockCreateInvitation).toHaveBeenCalledWith(
      'invite@example.com',
      { tenantId, organizationId: orgId },
      expect.objectContaining({
        invitedByUserId: null,
      }),
    )
  })
})
