/**
 * @jest-environment node
 */

import * as React from 'react'

const mockFindRouteManifestMatch = jest.fn()
const mockGetCustomerAuthFromCookies = jest.fn()
const mockRedirect = jest.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`)
})
const mockResolve = jest.fn()
const mockFindOne = jest.fn()

jest.mock('next/navigation', () => ({
  notFound: jest.fn(() => {
    throw new Error('NEXT_NOT_FOUND')
  }),
  redirect: (url: string) => mockRedirect(url),
}))

jest.mock('@/.mercato/generated/frontend-routes.generated', () => ({
  frontendRoutes: [],
}))

jest.mock('@/.mercato/generated/frontend-middleware.generated', () => ({
  frontendMiddlewareEntries: [],
}))

jest.mock('@open-mercato/shared/modules/registry', () => ({
  registerFrontendRouteManifests: jest.fn(),
  getFrontendRouteManifests: jest.fn(() => []),
  findRouteManifestMatch: (...args: unknown[]) => mockFindRouteManifestMatch(...args),
}))

jest.mock('@open-mercato/core/modules/customer_accounts/lib/customerAuthServer', () => ({
  getCustomerAuthFromCookies: (...args: unknown[]) => mockGetCustomerAuthFromCookies(...args),
}))

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: jest.fn(async () => ({ resolve: mockResolve })),
}))

jest.mock('@open-mercato/shared/lib/i18n/server', () => ({
  resolveTranslations: jest.fn(async () => ({ translate: (_key: string, fallback: string) => fallback })),
}))

jest.mock('@/bootstrap', () => ({
  bootstrap: jest.fn(),
}))

jest.mock('@/lib/metadata', () => ({
  resolveLocalizedTitleMetadata: jest.fn(async () => ({})),
}))

function containsElementType(node: unknown, targetType: string): boolean {
  if (!node || typeof node !== 'object') return false
  if (Array.isArray(node)) return node.some((child) => containsElementType(child, targetType))
  const element = node as { type?: unknown; props?: { children?: unknown } }
  if (element.type === targetType) return true
  return containsElementType(element.props?.children, targetType)
}

describe('SiteCatchAll portal auth scope', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockFindRouteManifestMatch.mockReturnValue({
      route: {
        requireCustomerAuth: true,
        load: async () => function ProtectedPortalPage() {
          return React.createElement('protected-portal-page')
        },
      },
      params: { orgSlug: 'org-a' },
    })
    mockFindOne.mockResolvedValue({
      id: '22222222-2222-4222-8222-222222222222',
      tenant: { id: '11111111-1111-4111-8111-111111111111' },
      slug: 'org-a',
    })
    mockResolve.mockImplementation((name: string) => {
      if (name === 'em') return { findOne: mockFindOne }
      throw new Error(`unexpected resolve(${name})`)
    })
    mockGetCustomerAuthFromCookies.mockResolvedValue(null)
  })

  afterEach(() => {
    jest.resetModules()
  })

  it('redirects instead of rendering when a customer JWT belongs to another organization', async () => {
    const { default: SiteCatchAll } = await import('../(frontend)/[...slug]/page')

    await expect(
      SiteCatchAll({ params: Promise.resolve({ slug: ['org-a', 'portal', 'dashboard'] }) }),
    ).rejects.toThrow('NEXT_REDIRECT:/org-a/portal/login')

    expect(mockRedirect).toHaveBeenCalledWith('/org-a/portal/login')
  })

  it('denies access instead of rendering when the customer JWT belongs to another organization', async () => {
    mockGetCustomerAuthFromCookies.mockResolvedValue({
      sub: '33333333-3333-4333-8333-333333333333',
      orgId: '44444444-4444-4444-8444-444444444444',
      tenantId: '11111111-1111-4111-8111-111111111111',
      email: 'someone@example.com',
    })
    const { default: SiteCatchAll } = await import('../(frontend)/[...slug]/page')

    const tree = await SiteCatchAll({ params: Promise.resolve({ slug: ['org-a', 'portal', 'dashboard'] }) })

    expect(containsElementType(tree, 'protected-portal-page')).toBe(false)
    expect(mockRedirect).not.toHaveBeenCalled()
  })
})
