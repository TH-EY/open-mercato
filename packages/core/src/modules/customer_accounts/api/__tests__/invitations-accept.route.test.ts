/** @jest-environment node */

const mockAcceptInvitation = jest.fn()
const mockFindByToken = jest.fn()
const mockLoadAcl = jest.fn()
const mockCreateSession = jest.fn()
const mockEmit = jest.fn(async () => undefined)
const mockResolveTenantContext = jest.fn()
const mockEmFindOne = jest.fn()

const tenantId = '11111111-1111-4111-8111-111111111111'
const organizationId = '22222222-2222-4222-8222-222222222222'
const userId = '33333333-3333-4333-8333-333333333333'
const invitationId = '44444444-4444-4444-8444-444444444444'

const invitedUser = {
  id: userId,
  email: 'buyer@example.com',
  displayName: 'Buyer User',
  tenantId,
  organizationId,
}

const mockContainer = {
  resolve: jest.fn((token: string) => {
    if (token === 'customerInvitationService') {
      return { acceptInvitation: mockAcceptInvitation, findByToken: mockFindByToken }
    }
    // fork-only: this fork's accept route resolves the post-accept session features
    // through getEffectiveFeatures scoped to the accepted user's organization.
    if (token === 'customerRbacService') {
      return {
        loadAcl: mockLoadAcl,
        getEffectiveFeatures: jest.fn(async (userId: string, scope: unknown) => {
          const acl = (await mockLoadAcl(userId, scope)) as { features?: string[] } | null
          return acl?.features ?? []
        }),
      }
    }
    if (token === 'customerSessionService') return { createSession: mockCreateSession }
    if (token === 'em') return { findOne: mockEmFindOne }
    return null
  }),
}

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: jest.fn(async () => mockContainer),
}))

jest.mock('@open-mercato/core/modules/customer_accounts/events', () => ({
  emitCustomerAccountsEvent: (...args: unknown[]) => mockEmit(...args),
}))

jest.mock('@open-mercato/core/modules/customer_accounts/lib/resolveTenantContext', () => {
  class TenantResolutionError extends Error {
    constructor(message: string, public readonly status: number) {
      super(message)
    }
  }
  return {
    TenantResolutionError,
    resolveTenantContext: (...args: unknown[]) => mockResolveTenantContext(...args),
  }
})

function readSetCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] }
  const direct = headers.getSetCookie?.()
  if (direct?.length) return direct
  const combined = headers.get('set-cookie')
  return combined ? [combined] : []
}

function makeAcceptRequest(): Request {
  return new Request('http://localhost/wrong-org/portal/invite?token=invite-token', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'route-test',
    },
    body: JSON.stringify({
      token: 'invite-token',
      password: 'Secret123!',
      displayName: 'Buyer User',
      organizationId,
    }),
  })
}

describe('customer invitation accept route', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockFindByToken.mockResolvedValue({
      id: invitationId,
      tenantId,
      organizationId,
      acceptedAt: null,
      cancelledAt: null,
    })
    mockResolveTenantContext.mockResolvedValue({
      tenantId,
      organizationId,
      source: 'body',
      hostname: 'localhost',
    })
    mockEmFindOne.mockResolvedValue({
      id: organizationId,
      slug: 'canonical-org',
      deletedAt: null,
    })
    mockAcceptInvitation.mockResolvedValue({
      user: invitedUser,
      invitation: { id: invitationId, tenantId, organizationId },
    })
    mockLoadAcl.mockResolvedValue({ features: ['portal.dashboard.view'] })
    mockCreateSession.mockResolvedValue({ rawToken: 'raw-session-token', jwt: 'jwt-session-token' })
  })

  it('creates the post-accept session from the accepted user organization, not the current page context', async () => {
    const { POST } = await import('../invitations/accept')

    const response = await POST(makeAcceptRequest())
    const body = await response.json()

    expect(response.status).toBe(201)
    expect(body).toMatchObject({
      ok: true,
      user: {
        id: userId,
        email: 'buyer@example.com',
        displayName: 'Buyer User',
        emailVerified: true,
      },
      resolvedFeatures: ['portal.dashboard.view'],
      redirectTo: '/canonical-org/portal/dashboard',
    })
    expect(mockFindByToken).toHaveBeenCalledWith('invite-token')
    expect(mockResolveTenantContext).toHaveBeenCalledWith(
      expect.any(Request),
      null,
      { container: mockContainer, organizationId },
    )
    expect(mockAcceptInvitation).toHaveBeenCalledWith('invite-token', 'Secret123!', 'Buyer User')
    expect(mockLoadAcl).toHaveBeenCalledWith(userId, { tenantId, organizationId })
    expect(mockCreateSession).toHaveBeenCalledWith(
      invitedUser,
      ['portal.dashboard.view'],
      null,
      'route-test',
    )

    const setCookies = readSetCookies(response).join('\n')
    expect(setCookies).toContain('customer_auth_token=jwt-session-token')
    expect(setCookies).toContain('customer_session_token=raw-session-token')
  })

  it('rejects a wrong-org portal context without creating a user, session, event, or cookies', async () => {
    mockResolveTenantContext.mockResolvedValueOnce({
      tenantId,
      organizationId: '99999999-9999-4999-8999-999999999999',
      source: 'body',
      hostname: 'localhost',
    })
    const { POST } = await import('../invitations/accept')

    const response = await POST(makeAcceptRequest())
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body).toEqual({ ok: false, error: 'Invalid or expired invitation' })
    expect(mockAcceptInvitation).not.toHaveBeenCalled()
    expect(mockLoadAcl).not.toHaveBeenCalled()
    expect(mockCreateSession).not.toHaveBeenCalled()
    expect(mockEmit).not.toHaveBeenCalled()
    expect(readSetCookies(response)).toHaveLength(0)
  })
})
