import { NextRequest } from 'next/server'
import { z } from 'zod'
import type { ApiRouteManifestEntry, Module } from '@open-mercato/shared/modules/registry'
import { registerModules } from '@open-mercato/shared/lib/modules/registry'
import { GET } from '../endpoints/route'
import {
  buildEndpointCatalog,
  clearWorkflowEndpointCatalogForTests,
} from '../../lib/endpoint-catalog'

jest.mock('@open-mercato/shared/modules/registry', () => ({
  ...jest.requireActual('@open-mercato/shared/modules/registry'),
  getApiRouteManifests: jest.fn(() => []),
}))

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: jest.fn(),
}))

jest.mock('@open-mercato/shared/lib/auth/server', () => ({
  getAuthFromRequest: jest.fn(),
}))

jest.mock('@open-mercato/core/modules/directory/utils/organizationScope', () => ({
  resolveOrganizationScopeForRequest: jest.fn(),
}))

const noopHandler = async () => new Response(null)

function testModules(): Module[] {
  return [{
    id: 'customers',
    apis: [
      {
        path: '/customers/people',
        handlers: { GET: noopHandler, POST: noopHandler },
        docs: {
          tag: 'Customers',
          methods: {
            GET: {
              summary: 'List people',
              query: z.object({
                search: z.string().optional(),
                page: z.coerce.number(),
              }),
              responses: [{
                status: 200,
                description: 'People',
                schema: z.object({
                  data: z.array(z.object({ id: z.string() })),
                  total: z.number(),
                }),
              }],
            },
            POST: {
              summary: 'Create person',
              requestBody: { schema: z.object({ name: z.string() }) },
              responses: [{
                status: 201,
                description: 'Created',
                schema: z.object({ id: z.string() }),
              }],
            },
          },
        },
      },
      {
        path: '/customers/people/[id]',
        handlers: { GET: noopHandler },
        docs: {
          methods: {
            GET: {
              summary: 'Get person',
              responses: [{ status: 200, description: 'Success' }],
            },
          },
        },
      },
    ],
  } as unknown as Module]
}

function manifestBackedModules(): Module[] {
  return [{
    id: 'inventory',
    apis: [{
      path: '/inventory/items/[id]',
      handlers: { PUT: noopHandler },
    }],
  } as unknown as Module]
}

const manifestBackedRoutes: ApiRouteManifestEntry[] = [{
  moduleId: 'inventory',
  kind: 'route-file',
  path: '/inventory/items/[id]',
  methods: ['PUT'],
  load: async () => ({
    openApi: {
      tag: 'Inventory',
      methods: {
        PUT: {
          summary: 'Update inventory item',
          requestBody: { schema: z.object({ quantity: z.number() }) },
          responses: [{
            status: 200,
            description: 'Updated',
            schema: z.object({ id: z.string(), quantity: z.number() }),
          }],
        },
      },
    },
  }),
}]

describe('GET /api/workflows/endpoints', () => {
  const request = () => new NextRequest('http://localhost/api/workflows/endpoints')
  const rbacService = { userHasAllFeatures: jest.fn() }

  beforeEach(() => {
    clearWorkflowEndpointCatalogForTests()
    registerModules(testModules())
    rbacService.userHasAllFeatures.mockResolvedValue(true)

    const { createRequestContainer } = require('@open-mercato/shared/lib/di/container')
    createRequestContainer.mockResolvedValue({
      resolve: (name: string) => name === 'rbacService' ? rbacService : null,
    })
    const { getAuthFromRequest } = require('@open-mercato/shared/lib/auth/server')
    getAuthFromRequest.mockResolvedValue({
      sub: 'user-1',
      tenantId: 'tenant-1',
      orgId: 'org-1',
    })
    const { resolveOrganizationScopeForRequest } = require(
      '@open-mercato/core/modules/directory/utils/organizationScope'
    )
    resolveOrganizationScopeForRequest.mockResolvedValue({ selectedId: 'org-1' })
  })

  afterEach(() => {
    clearWorkflowEndpointCatalogForTests()
    jest.clearAllMocks()
  })

  it('returns sorted operations, parameter hints, and declared schemas', async () => {
    const response = await GET(request())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.items.map((item: { method: string; path: string }) => `${item.method} ${item.path}`)).toEqual([
      'GET /api/customers/people',
      'POST /api/customers/people',
      'GET /api/customers/people/{id}',
    ])
    expect(body.items[0].params).toEqual([
      { name: 'search', in: 'query', required: false, type: 'string' },
      { name: 'page', in: 'query', required: true, type: 'number' },
    ])
    expect(body.items[0].responseSchema.properties.data.type).toBe('array')
    expect(body.items[1].requestSchema.properties.name.type).toBe('string')
    expect(body.items[2].responseSchema).toBeUndefined()
  })

  it('checks workflow definition view access in the selected organization', async () => {
    await GET(request())
    expect(rbacService.userHasAllFeatures).toHaveBeenCalledWith(
      'user-1',
      ['workflows.definitions.view'],
      { tenantId: 'tenant-1', organizationId: 'org-1' },
    )
  })

  it('uses manifests passed by the API catch-all across the lazy route boundary', async () => {
    registerModules(manifestBackedModules())
    clearWorkflowEndpointCatalogForTests()

    const response = await GET(request(), { apiRouteManifests: manifestBackedRoutes })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.items).toHaveLength(1)
    expect(body.items[0]).toMatchObject({
      path: '/api/inventory/items/{id}',
      method: 'PUT',
      summary: 'Update inventory item',
      hasRequestSchema: true,
    })
    expect(body.items[0].requestSchema.properties.quantity.type).toBe('number')
    expect(body.items[0].responseSchema.properties.id.type).toBe('string')
  })

  it.each([
    ['unauthenticated', 401, async () => {
      const { getAuthFromRequest } = require('@open-mercato/shared/lib/auth/server')
      getAuthFromRequest.mockResolvedValue(null)
    }],
    ['missing tenant', 400, async () => {
      const { getAuthFromRequest } = require('@open-mercato/shared/lib/auth/server')
      getAuthFromRequest.mockResolvedValue({ sub: 'user-1', tenantId: null, orgId: 'org-1' })
    }],
    ['missing feature', 403, async () => {
      rbacService.userHasAllFeatures.mockResolvedValue(false)
    }],
  ])('returns the expected status when %s', async (_name, expectedStatus, arrange) => {
    await arrange()
    expect((await GET(request())).status).toBe(expectedStatus)
  })
})

describe('buildEndpointCatalog', () => {
  it('sorts route methods deterministically', () => {
    const modules = [{
      id: 'test',
      apis: [{
        path: '/zeta',
        handlers: { POST: noopHandler, GET: noopHandler },
        docs: { methods: { POST: { summary: 'Create' }, GET: { summary: 'List' } } },
      }],
    }] as unknown as Module[]

    expect(buildEndpointCatalog(modules).items.map((item) => item.method)).toEqual(['GET', 'POST'])
  })
})
