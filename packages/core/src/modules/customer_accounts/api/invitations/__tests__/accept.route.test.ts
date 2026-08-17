/** @jest-environment node */

const mockAcceptInvitation = jest.fn()
const mockGetEffectiveFeatures = jest.fn()
const mockCreateSession = jest.fn()
const mockEmitCustomerAccountsEvent = jest.fn(async () => undefined)

const tenantId = '11111111-1111-4111-8111-111111111111'
const organizationId = '22222222-2222-4222-8222-222222222222'
const invitationId = '33333333-3333-4333-8333-333333333333'
const userId = '44444444-4444-4444-8444-444444444444'

const mockContainer = {
  resolve: jest.fn((token: string) => {
    if (token === 'customerInvitationService') return { acceptInvitation: mockAcceptInvitation }
    if (token === 'customerRbacService') return { getEffectiveFeatures: mockGetEffectiveFeatures }
    if (token === 'customerSessionService') return { createSession: mockCreateSession }
    return null
  }),
}

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: jest.fn(async () => mockContainer),
}))

jest.mock('@open-mercato/core/modules/customer_accounts/events', () => ({
  emitCustomerAccountsEvent: (...args: unknown[]) => mockEmitCustomerAccountsEvent(...args),
}))

jest.mock('@open-mercato/shared/lib/ratelimit/helpers', () => ({
  getClientIp: jest.fn(() => '127.0.0.1'),
}))

function makeRequest(): Request {
  return new Request('http://localhost/api/customer_accounts/invitations/accept', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'THOM-100 test',
    },
    body: JSON.stringify({
      token: 'raw-token',
      password: 'Secret123!',
      displayName: 'Intermediary User',
    }),
  })
}

describe('customer invitation acceptance route', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockAcceptInvitation.mockResolvedValue({
      invitation: { id: invitationId },
      user: {
        id: userId,
        email: 'intermediary@example.com',
        displayName: 'Intermediary User',
        tenantId,
        organizationId,
      },
    })
    mockGetEffectiveFeatures.mockResolvedValue(['portal.finoo_intermediaries.view'])
    mockCreateSession.mockResolvedValue({ rawToken: 'session-token', jwt: 'jwt-token' })
    mockEmitCustomerAccountsEvent.mockResolvedValue(undefined)
  })

  it('emits the frozen invitation-accepted payload through the persistent queue', async () => {
    const { POST } = await import('../accept')

    const response = await POST(makeRequest())

    expect(response.status).toBe(201)
    expect(mockEmitCustomerAccountsEvent).toHaveBeenCalledWith(
      'customer_accounts.invitation.accepted',
      {
        invitationId,
        userId,
        tenantId,
      },
      { persistent: true },
    )
  })
})
