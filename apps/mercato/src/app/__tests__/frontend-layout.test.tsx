/**
 * @jest-environment node
 */

import * as React from 'react'
import type { ReactElement, ReactNode } from 'react'

const mockHeaders = jest.fn()
const mockGetCustomerAuthFromCookies = jest.fn()
const mockResolve = jest.fn()
const mockFindOne = jest.fn()
const mockGetBoolConfig = jest.fn()

jest.mock('next/headers', () => ({
  headers: (...args: unknown[]) => mockHeaders(...args),
}))

jest.mock('@open-mercato/ui/portal/PortalLayoutShell', () => ({
  PortalLayoutShell: ({ children, ...props }: { children: ReactNode } & Record<string, unknown>) =>
    React.createElement('portal-layout-shell', { ...props }, children),
}))

jest.mock('@open-mercato/core/modules/customer_accounts/lib/customerAuthServer', () => ({
  getCustomerAuthFromCookies: (...args: unknown[]) => mockGetCustomerAuthFromCookies(...args),
}))

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: jest.fn(async () => ({ resolve: mockResolve })),
}))

jest.mock('@open-mercato/shared/lib/i18n/server', () => ({
  resolveTranslations: jest.fn(async () => ({ t: (_key: string, fallback: string) => fallback })),
}))

function findElementByType(node: ReactNode, targetType: unknown): ReactElement | null {
  if (!node || typeof node !== 'object') return null
  const element = node as ReactElement<{ children?: ReactNode }>
  if (element.type === targetType) return element
  const children = element.props?.children
  if (Array.isArray(children)) {
    for (const child of children) {
      const match = findElementByType(child, targetType)
      if (match) return match
    }
    return null
  }
  return findElementByType(children, targetType)
}

describe('FrontendLayout portal auth scope', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockHeaders.mockResolvedValue({
      get: (name: string) => (name === 'x-next-url' ? '/org-a/portal/dashboard' : null),
    })
    mockFindOne.mockImplementation(async (_entity: unknown, where: Record<string, unknown>) => {
      if (where.slug === 'org-a') {
        return {
          id: '22222222-2222-4222-8222-222222222222',
          name: 'Org A',
          tenant: { id: '11111111-1111-4111-8111-111111111111' },
        }
      }
      return null
    })
    mockGetBoolConfig.mockResolvedValue({ ok: true, value: true })
    mockResolve.mockImplementation((name: string) => {
      if (name === 'em') return { findOne: mockFindOne }
      if (name === 'featureTogglesService') return { getBoolConfig: mockGetBoolConfig }
      return null
    })
  })

  afterEach(() => {
    jest.resetModules()
  })

  it('requires the customer JWT to match the portal route organization', async () => {
    mockGetCustomerAuthFromCookies.mockResolvedValue(null)
    const { default: FrontendLayout } = await import('../(frontend)/layout')
    const { PortalLayoutShell } = await import('@open-mercato/ui/portal/PortalLayoutShell')

    const tree = await FrontendLayout({ children: 'child' })
    const shell = findElementByType(tree, PortalLayoutShell)

    expect(mockGetCustomerAuthFromCookies).toHaveBeenCalledWith({
      expectedTenantId: '11111111-1111-4111-8111-111111111111',
      expectedOrganizationId: '22222222-2222-4222-8222-222222222222',
    })
    expect(shell).not.toBeNull()
    expect(shell?.props.authenticated).toBe(false)
    expect(shell?.props.customerAuth).toBeNull()
  })
})
