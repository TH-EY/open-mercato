/** @jest-environment node */

import { NextResponse } from 'next/server'
import { FinooIntermediary } from '../data/entities'

const mockCheckAuthRateLimit = jest.fn()
const mockCreateStaffRequestContext = jest.fn()
const mockExecuteGuardedCommand = jest.fn()
const mockSerializeDirectoryCommandResult = jest.fn()
const mockLoadDirectoryById = jest.fn()

jest.mock('@open-mercato/core/modules/customer_accounts/lib/rateLimiter', () => ({
  checkAuthRateLimit: (...args: unknown[]) => mockCheckAuthRateLimit(...args),
  customerInviteIpRateLimitConfig: { keyPrefix: 'invite-ip' },
  customerInviteRateLimitConfig: { keyPrefix: 'invite-email' },
}))

jest.mock('@open-mercato/core/modules/customer_accounts/lib/rateLimitIdentifier', () => ({
  readNormalizedEmailFromJsonRequest: jest.fn(async () => 'person@example.com'),
}))

jest.mock('../lib/http', () => ({
  createStaffRequestContext: (...args: unknown[]) => mockCreateStaffRequestContext(...args),
  routeErrorResponse: (error: unknown) => NextResponse.json({ error: String(error) }, { status: 500 }),
  unauthorizedResponse: () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
  executeGuardedCommand: (...args: unknown[]) => mockExecuteGuardedCommand(...args),
}))

jest.mock('../lib/directory-lifecycle', () => ({
  loadDirectoryById: (...args: unknown[]) => mockLoadDirectoryById(...args),
}))

jest.mock('../lib/directory-api', () => {
  const actual = jest.requireActual('../lib/directory-api')
  return {
    ...actual,
    serializeDirectoryCommandResult: (...args: unknown[]) => mockSerializeDirectoryCommandResult(...args),
  }
})

const tenantId = '11111111-1111-4111-8111-111111111111'
const organizationId = '22222222-2222-4222-8222-222222222222'
const intermediaryId = '33333333-3333-4333-8333-333333333333'

function request() {
  return new Request('http://localhost/api/finoo_intermediaries/admin/directory/invite', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'person@example.com', firstName: 'First', lastName: 'Last' }),
  })
}

function lifecycleRequest(path: string, body: Record<string, unknown> = {}) {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedUpdatedAt: '2026-08-17T12:00:00.000Z', ...body }),
  })
}

describe('intermediary directory routes', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCheckAuthRateLimit.mockResolvedValue({ error: null })
    mockCreateStaffRequestContext.mockResolvedValue({
      em: {}, container: {}, ctx: {}, tenantId, organizationId, actorId: intermediaryId,
    })
    const intermediary = new FinooIntermediary()
    intermediary.id = intermediaryId
    intermediary.email = 'person@example.com'
    mockLoadDirectoryById.mockResolvedValue(intermediary)
    mockExecuteGuardedCommand.mockResolvedValue({ intermediary })
    mockSerializeDirectoryCommandResult.mockResolvedValue({
      item: { id: intermediaryId, status: 'invited' },
    })
  })

  it('declares exact route feature gates', async () => {
    const invite = await import('../api/admin/directory/invite/route')
    const edit = await import('../api/admin/directory/[id]/route')
    const deactivate = await import('../api/admin/directory/[id]/deactivate/route')
    const reactivate = await import('../api/admin/directory/[id]/reactivate/route')
    const list = await import('../api/admin/directory/route')

    expect(list.metadata.GET.requireFeatures).toEqual(['finoo_intermediaries.view'])
    expect(invite.metadata.POST.requireFeatures).toEqual([
      'finoo_intermediaries.manage', 'customer_accounts.invite', 'customer_accounts.manage',
    ])
    expect(edit.metadata.PUT.requireFeatures).toEqual(['finoo_intermediaries.manage'])
    expect(deactivate.metadata.POST.requireFeatures).toEqual([
      'finoo_intermediaries.manage', 'customer_accounts.manage',
    ])
    expect(reactivate.metadata.POST.requireFeatures).toEqual([
      'finoo_intermediaries.manage', 'customer_accounts.manage',
    ])
  })

  it('short-circuits a rate-limited invite before auth context or mutation guards', async () => {
    mockCheckAuthRateLimit.mockResolvedValue({
      error: NextResponse.json({ error: 'Too many requests' }, { status: 429 }),
    })
    const { POST } = await import('../api/admin/directory/invite/route')
    const response = await POST(request())

    expect(response.status).toBe(429)
    expect(mockCreateStaffRequestContext).not.toHaveBeenCalled()
    expect(mockExecuteGuardedCommand).not.toHaveBeenCalled()
  })

  it('runs the invite through mutation guards and maps durable failure to a safe 502 item', async () => {
    const intermediary = new FinooIntermediary()
    intermediary.id = intermediaryId
    mockExecuteGuardedCommand.mockResolvedValue({ intermediary, deliveryFailed: true })
    const { POST } = await import('../api/admin/directory/invite/route')
    const response = await POST(request())
    const json = await response.json()

    expect(mockExecuteGuardedCommand).toHaveBeenCalledWith(expect.objectContaining({
      commandId: 'finoo_intermediaries.intermediary.invite',
      operation: 'create',
      resourceKind: 'finoo_intermediaries.intermediary',
    }))
    expect(response.status).toBe(502)
    expect(json).toEqual({
      code: 'invitation_delivery_failed',
      item: { id: intermediaryId, status: 'invited' },
    })
    expect(JSON.stringify(json)).not.toContain('token')
    expect(JSON.stringify(json)).not.toContain('hash')
  })

  it.each([
    ['resend', '../api/admin/directory/[id]/resend/route'],
    ['reactivate', '../api/admin/directory/[id]/reactivate/route'],
  ])('rate-limits %s after a scoped email lookup and before the command', async (_label, modulePath) => {
    mockCheckAuthRateLimit.mockResolvedValue({
      error: NextResponse.json({ error: 'Too many requests' }, { status: 429 }),
    })
    const route = await import(modulePath)
    const response = await route.POST(
      lifecycleRequest(`/api/finoo_intermediaries/admin/directory/${intermediaryId}/${_label}`),
      { params: Promise.resolve({ id: intermediaryId }) },
    )

    expect(response.status).toBe(429)
    expect(mockLoadDirectoryById).toHaveBeenCalledWith(
      expect.anything(), intermediaryId, expect.objectContaining({ tenantId, organizationId }),
    )
    expect(mockCheckAuthRateLimit).toHaveBeenCalledWith(expect.objectContaining({
      compoundIdentifier: 'person@example.com',
    }))
    expect(mockExecuteGuardedCommand).not.toHaveBeenCalled()
  })

  it('rate-limits an email edit before mutation', async () => {
    mockCheckAuthRateLimit.mockResolvedValue({
      error: NextResponse.json({ error: 'Too many requests' }, { status: 429 }),
    })
    const route = await import('../api/admin/directory/[id]/route')
    const response = await route.PUT(
      new Request(`http://localhost/api/finoo_intermediaries/admin/directory/${intermediaryId}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          firstName: 'First',
          lastName: 'Last',
          email: 'replacement@example.com',
          expectedUpdatedAt: '2026-08-17T12:00:00.000Z',
        }),
      }),
      { params: Promise.resolve({ id: intermediaryId }) },
    )

    expect(response.status).toBe(429)
    expect(mockCheckAuthRateLimit).toHaveBeenCalledWith(expect.objectContaining({
      compoundIdentifier: 'replacement@example.com',
    }))
    expect(mockExecuteGuardedCommand).not.toHaveBeenCalled()
  })

  it('lets linked Reactivate reach the guarded command without a static invite permission', async () => {
    const linked = new FinooIntermediary()
    linked.id = intermediaryId
    linked.email = 'person@example.com'
    linked.customerUserId = '44444444-4444-4444-8444-444444444444'
    mockLoadDirectoryById.mockResolvedValue(linked)
    mockSerializeDirectoryCommandResult.mockResolvedValue({
      item: { id: intermediaryId, status: 'active' },
    })
    const route = await import('../api/admin/directory/[id]/reactivate/route')
    const response = await route.POST(
      lifecycleRequest(`/api/finoo_intermediaries/admin/directory/${intermediaryId}/reactivate`),
      { params: Promise.resolve({ id: intermediaryId }) },
    )

    expect(route.metadata.POST.requireFeatures).toEqual([
      'finoo_intermediaries.manage', 'customer_accounts.manage',
    ])
    expect(response.status).toBe(200)
    expect(mockExecuteGuardedCommand).toHaveBeenCalledWith(expect.objectContaining({
      commandId: 'finoo_intermediaries.intermediary.reactivate',
      operation: 'update',
    }))
  })

  it('documents durable 502 responses with the required code and item', async () => {
    const edit = await import('../api/admin/directory/[id]/route')
    const resend = await import('../api/admin/directory/[id]/resend/route')
    const reactivate = await import('../api/admin/directory/[id]/reactivate/route')
    const safeFailure = {
      code: 'invitation_delivery_failed',
      item: {
        id: intermediaryId,
        firstName: 'First',
        lastName: 'Last',
        email: 'person@example.com',
        status: 'delivery_failed',
        hasLinkedAccount: false,
        relatedDeals: 0,
        invitationExpiresAt: '2026-08-20T12:00:00.000Z',
        lastEmailStatus: 'failed',
        lastEmailErrorCode: 'email_delivery_failed',
        updatedAt: '2026-08-17T12:00:00.000Z',
      },
    }
    for (const method of [edit.openApi.methods.PUT, resend.openApi.methods.POST, reactivate.openApi.methods.POST]) {
      const schema = method?.errors?.find((entry) => entry.status === 502)?.schema
      expect(schema?.safeParse(safeFailure).success).toBe(true)
      expect(schema?.safeParse({ item: safeFailure.item }).success).toBe(false)
    }
  })
})
