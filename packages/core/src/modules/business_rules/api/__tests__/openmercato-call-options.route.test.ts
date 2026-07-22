/** @jest-environment node */

import { describe, test, expect, beforeEach, jest } from '@jest/globals'
import { registerModules } from '@open-mercato/shared/lib/modules/registry'
import { createAuthMock, createMockContainer, createMockEntityManager } from './test-helpers'

const mockGetAuthFromRequest = createAuthMock()
const mockEm = createMockEntityManager()
const mockContainer = createMockContainer(mockEm)
const mockUserHasAllFeatures = jest.fn(async () => true)
const mockLoadAcl = jest.fn(async () => ({
  isSuperAdmin: false,
  features: ['business_rules.view'],
  organizations: ['223e4567-e89b-12d3-a456-426614174000'],
}))

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: jest.fn(async () => mockContainer),
}))

jest.mock('@open-mercato/shared/lib/auth/server', () => ({
  getAuthFromRequest: jest.fn((request: Request) => mockGetAuthFromRequest(request)),
}))

type RouteModule = typeof import('../openmercato-call-options/route')
let GET: RouteModule['GET']
let metadata: RouteModule['metadata']

const handler = async () => new Response('{}')

function registerTestModules() {
  registerModules([
    {
      id: 'business_rules',
      info: { title: 'Business Rules' },
      apis: [
        {
          path: '/api/business_rules/rules',
          handlers: { GET: handler, POST: handler },
          docs: {
            methods: {
              GET: { summary: 'List business rules' },
              POST: { summary: 'Create business rule' },
            },
          },
        },
        {
          path: '/api/business_rules/openmercato-call-options',
          handlers: { GET: handler },
          docs: { methods: { GET: { summary: 'List options' } } },
        },
        {
          path: '/api/business_rules/rules/options',
          handlers: { GET: handler },
          docs: { methods: { GET: { summary: 'List business rule options' } } },
        },
        {
          path: '/api/docs/openapi',
          handlers: { GET: handler },
          docs: { methods: { GET: { summary: 'OpenAPI docs' } } },
        },
        {
          path: '/api/business_rules/rules/{id}',
          handlers: { GET: handler },
          docs: { methods: { GET: { summary: 'Read business rule' } } },
        },
        {
          path: '/api/business_rules/deprecated',
          handlers: { GET: handler },
          docs: { methods: { GET: { summary: 'Deprecated endpoint', deprecated: true } } },
        },
      ],
    },
  ] as any)
}

beforeAll(async () => {
  const routeModule = await import('../openmercato-call-options/route')
  GET = routeModule.GET
  metadata = routeModule.metadata
})

describe('Business Rules API - /api/business_rules/openmercato-call-options', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    registerTestModules()
    mockUserHasAllFeatures.mockResolvedValue(true)
    mockLoadAcl.mockResolvedValue({
      isSuperAdmin: false,
      features: ['business_rules.view'],
      organizations: ['223e4567-e89b-12d3-a456-426614174000'],
    })
    mockContainer.resolve.mockImplementation((token: string) => {
      if (token === 'em') return mockEm
      if (token === 'rbacService') {
        return {
          userHasAllFeatures: mockUserHasAllFeatures,
          loadAcl: mockLoadAcl,
        }
      }
      return undefined
    })
    mockGetAuthFromRequest.mockResolvedValue({
      sub: 'user-1',
      email: 'user@example.com',
      tenantId: '123e4567-e89b-12d3-a456-426614174000',
      orgId: '223e4567-e89b-12d3-a456-426614174000',
    })
  })

  test('should have correct RBAC requirements', () => {
    expect(metadata.GET).toEqual({
      requireAuth: true,
      requireFeatures: ['business_rules.manage', 'api_keys.view', 'api_keys.create'],
    })
  })

  test('should return 401 when not authenticated', async () => {
    mockGetAuthFromRequest.mockResolvedValue(null)

    const response = await GET(new Request('http://localhost:3000/api/business_rules/openmercato-call-options'))

    expect(response.status).toBe(401)
  })

  test('should return executable endpoint options and safe API key metadata', async () => {
    mockEm.find.mockImplementation(async (Entity: any) => {
      if (Entity?.name === 'ApiKey') {
        return [
          {
            id: 'api-key-1',
            name: 'Automation profile',
            keyPrefix: 'omk_1234.abc',
            tenantId: '123e4567-e89b-12d3-a456-426614174000',
            organizationId: '223e4567-e89b-12d3-a456-426614174000',
            rolesJson: ['role-1'],
            expiresAt: null,
            deletedAt: null,
          },
          {
            id: 'expired-key',
            name: 'Expired profile',
            keyPrefix: 'omk_expired',
            tenantId: '123e4567-e89b-12d3-a456-426614174000',
            organizationId: '223e4567-e89b-12d3-a456-426614174000',
            rolesJson: ['role-1'],
            expiresAt: new Date('2000-01-01T00:00:00.000Z'),
            deletedAt: null,
          },
        ]
      }
      if (Entity?.name === 'Role') {
        return [{ id: 'role-1', name: 'Business Rule Caller', tenantId: '123e4567-e89b-12d3-a456-426614174000' }]
      }
      if (Entity?.name === 'Organization') {
        return [{ id: '223e4567-e89b-12d3-a456-426614174000', name: 'Main Org' }]
      }
      return []
    })
    mockEm.findOne.mockImplementation(async (Entity: any) => {
      if (Entity?.name === 'User') {
        return {
          id: 'user-1',
          tenantId: '123e4567-e89b-12d3-a456-426614174000',
          organizationId: '223e4567-e89b-12d3-a456-426614174000',
        }
      }
      if (Entity?.name === 'RoleAcl') {
        return {
          isSuperAdmin: false,
          featuresJson: ['business_rules.view'],
          organizationsJson: ['223e4567-e89b-12d3-a456-426614174000'],
        }
      }
      return null
    })

    const response = await GET(new Request('http://localhost:3000/api/business_rules/openmercato-call-options'))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.endpoints).toEqual([
      expect.objectContaining({
        id: 'GET /api/business_rules/rules',
        path: '/api/business_rules/rules',
        method: 'GET',
        summary: 'List business rules',
      }),
      expect.objectContaining({
        id: 'POST /api/business_rules/rules',
        path: '/api/business_rules/rules',
        method: 'POST',
      }),
    ])
    expect(body.endpoints.map((endpoint: any) => endpoint.path)).not.toContain('/api/docs/openapi')
    expect(body.endpoints.map((endpoint: any) => endpoint.path)).not.toContain('/api/business_rules/openmercato-call-options')
    expect(body.endpoints.map((endpoint: any) => endpoint.path)).not.toContain('/api/business_rules/rules/options')
    expect(body.endpoints.map((endpoint: any) => endpoint.path)).not.toContain('/api/business_rules/rules/{id}')
    expect(body.endpoints.map((endpoint: any) => endpoint.path)).not.toContain('/api/business_rules/deprecated')

    expect(body.apiKeys).toEqual([
      {
        id: 'api-key-1',
        name: 'Automation profile',
        keyPrefix: 'omk_1234.abc',
        organizationId: '223e4567-e89b-12d3-a456-426614174000',
        organizationName: 'Main Org',
        roles: [{ id: 'role-1', name: 'Business Rule Caller' }],
      },
    ])
    expect(JSON.stringify(body.apiKeys)).not.toContain('keyHash')
    expect(JSON.stringify(body.apiKeys)).not.toContain('secret')
  })

  test('should return 403 without api_keys.create', async () => {
    mockUserHasAllFeatures.mockImplementation(async (_userId, required: string[]) => !required.includes('api_keys.create'))

    const response = await GET(new Request('http://localhost:3000/api/business_rules/openmercato-call-options'))
    const body = await response.json()

    expect(response.status).toBe(403)
    expect(body.requiredFeatures).toEqual(['business_rules.manage', 'api_keys.view', 'api_keys.create'])
  })

  test('should hide API key profiles whose roles are outside the actor grant ceiling', async () => {
    mockEm.find.mockImplementation(async (Entity: any, where: any) => {
      if (Entity?.name === 'ApiKey') {
        return [
          {
            id: 'api-key-allowed',
            name: 'Allowed profile',
            keyPrefix: 'omk_allowed',
            tenantId: '123e4567-e89b-12d3-a456-426614174000',
            organizationId: '223e4567-e89b-12d3-a456-426614174000',
            rolesJson: ['role-allowed'],
            expiresAt: null,
            deletedAt: null,
          },
          {
            id: 'api-key-denied',
            name: 'Denied profile',
            keyPrefix: 'omk_denied',
            tenantId: '123e4567-e89b-12d3-a456-426614174000',
            organizationId: '223e4567-e89b-12d3-a456-426614174000',
            rolesJson: ['role-denied'],
            expiresAt: null,
            deletedAt: null,
          },
        ]
      }
      if (Entity?.name === 'Role') {
        const ids = where?.id?.$in ?? []
        return [
          { id: 'role-allowed', name: 'Allowed', tenantId: '123e4567-e89b-12d3-a456-426614174000' },
          { id: 'role-denied', name: 'Denied', tenantId: '123e4567-e89b-12d3-a456-426614174000' },
        ].filter((role) => ids.includes(role.id))
      }
      if (Entity?.name === 'Organization') {
        return [{ id: '223e4567-e89b-12d3-a456-426614174000', name: 'Main Org' }]
      }
      return []
    })
    mockEm.findOne.mockImplementation(async (Entity: any, where: any) => {
      if (Entity?.name === 'User') {
        return {
          id: 'user-1',
          tenantId: '123e4567-e89b-12d3-a456-426614174000',
          organizationId: '223e4567-e89b-12d3-a456-426614174000',
        }
      }
      if (Entity?.name === 'RoleAcl') {
        const roleId = typeof where?.role === 'object' ? where.role.id : where?.role
        return {
          isSuperAdmin: false,
          featuresJson: roleId === 'role-denied' ? ['catalog.categories.manage'] : ['business_rules.view'],
          organizationsJson: ['223e4567-e89b-12d3-a456-426614174000'],
        }
      }
      return null
    })
    mockLoadAcl.mockResolvedValue({
      isSuperAdmin: false,
      features: ['business_rules.view'],
      organizations: ['223e4567-e89b-12d3-a456-426614174000'],
    })

    const response = await GET(new Request('http://localhost:3000/api/business_rules/openmercato-call-options'))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.apiKeys.map((apiKey: any) => apiKey.id)).toEqual(['api-key-allowed'])
  })
})
