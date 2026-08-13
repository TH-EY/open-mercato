/** @jest-environment node */

import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'

const readJsonSafe = jest.fn()
const execute = jest.fn()

jest.mock('@open-mercato/shared/lib/auth/server', () => ({
  getAuthFromRequest: jest.fn().mockResolvedValue({
    sub: 'user',
    tenantId: '00000000-0000-4000-8000-000000000001',
    orgId: '00000000-0000-4000-8000-000000000002',
    features: ['finoo_affiliates.manage'],
  }),
}))
jest.mock('@open-mercato/shared/lib/http/readJsonSafe', () => ({ readJsonSafe: (...args: unknown[]) => readJsonSafe(...args) }))
jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: jest.fn().mockResolvedValue({ resolve: () => ({ execute }) }),
}))
jest.mock('@open-mercato/core/modules/directory/utils/organizationScope', () => ({
  resolveOrganizationScopeForRequest: jest.fn().mockResolvedValue({
    selectedId: '00000000-0000-4000-8000-000000000002',
    allowedIds: ['00000000-0000-4000-8000-000000000002'],
  }),
}))
jest.mock('@open-mercato/shared/lib/crud/mutation-guard-registry', () => ({
  bridgeLegacyGuard: jest.fn().mockReturnValue(null),
  runMutationGuards: jest.fn(),
}))

import { metadata, POST } from '../route'

describe('ensure affiliate invitation route', () => {
  const originalAppUrl = process.env.APP_URL
  const originalNextPublicAppUrl = process.env.NEXT_PUBLIC_APP_URL

  beforeEach(() => {
    jest.clearAllMocks()
    delete process.env.NEXT_PUBLIC_APP_URL
    if (originalAppUrl === undefined) delete process.env.APP_URL
    else process.env.APP_URL = originalAppUrl
  })

  afterAll(() => {
    if (originalAppUrl === undefined) delete process.env.APP_URL
    else process.env.APP_URL = originalAppUrl
    if (originalNextPublicAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL
    else process.env.NEXT_PUBLIC_APP_URL = originalNextPublicAppUrl
  })

  it('declares the manage feature and safely rejects malformed JSON', async () => {
    readJsonSafe.mockResolvedValue(null)
    const response = await POST(new Request('https://example.test/api', { method: 'POST', body: '{' }))
    expect(metadata.POST).toEqual({ requireAuth: true, requireFeatures: ['finoo_affiliates.manage'] })
    expect(response.status).toBe(400)
    expect(readJsonSafe).toHaveBeenCalled()
  })

  it('preserves a command domain error status', async () => {
    readJsonSafe.mockResolvedValue({ invitationId: '00000000-0000-4000-8000-000000000003' })
    execute.mockRejectedValue(new CrudHttpError(409, { error: 'INVITATION_NOT_FOR_AFFILIATE' }))
    const response = await POST(new Request('https://example.test/api', { method: 'POST', body: '{}' }))
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: 'INVITATION_NOT_FOR_AFFILIATE' })
  })

  it('builds the tracked URL from the configured public application URL', async () => {
    process.env.APP_URL = 'https://finoo.example.test'
    readJsonSafe.mockResolvedValue({ invitationId: '00000000-0000-4000-8000-000000000003' })
    execute.mockResolvedValue({
      result: {
        created: true,
        affiliate: {
          id: '00000000-0000-4000-8000-000000000004',
          code: 'PUBLIC123',
          isActive: false,
        },
      },
    })

    const response = await POST(new Request('http://localhost:3000/api', { method: 'POST', body: '{}' }))

    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toMatchObject({
      affiliate: {
        trackedUrl: 'https://finoo.example.test/api/finoo_affiliates/r/PUBLIC123',
      },
    })
  })
})
