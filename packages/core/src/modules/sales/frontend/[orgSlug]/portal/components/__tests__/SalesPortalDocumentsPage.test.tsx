/**
 * @jest-environment jsdom
 */
import * as React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { SalesPortalDocumentsPage } from '../SalesPortalDocumentsPage'

const mockUseParams = jest.fn()
const mockUsePathname = jest.fn()
const mockApiCall = jest.fn()

jest.mock('next/navigation', () => ({
  useParams: () => mockUseParams(),
  usePathname: () => mockUsePathname(),
}))

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({
    href,
    children,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string | { toString(): string } }) => (
    <a href={typeof href === 'string' ? href : href.toString()} {...props}>
      {children}
    </a>
  ),
}))

jest.mock('@open-mercato/shared/lib/i18n/context', () => ({
  useT: () => (_key: string, fallback?: string) => fallback ?? _key,
}))

jest.mock('@open-mercato/ui/backend/utils/apiCall', () => ({
  apiCall: (...args: unknown[]) => mockApiCall(...args),
}))

jest.mock('@open-mercato/ui/portal/components/PortalPageHeader', () => ({
  PortalPageHeader: ({ title, description }: { title: string; description?: string }) => (
    <header>
      <h1>{title}</h1>
      {description ? <p>{description}</p> : null}
    </header>
  ),
}))

jest.mock('@open-mercato/ui/portal/components/PortalEmptyState', () => ({
  PortalEmptyState: ({ title, description }: { title: string; description?: string }) => (
    <div>
      <h2>{title}</h2>
      {description ? <p>{description}</p> : null}
    </div>
  ),
}))

jest.mock('@open-mercato/ui/portal/components/PortalCard', () => ({
  PortalCard: ({ children }: React.PropsWithChildren) => <section>{children}</section>,
}))

jest.mock('@open-mercato/ui/primitives/button', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type={props.type ?? 'button'} {...props}>
      {children}
    </button>
  ),
}))

jest.mock('@open-mercato/ui/primitives/input', () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}))

jest.mock('@open-mercato/ui/primitives/spinner', () => ({
  Spinner: () => <span data-testid="spinner" />,
}))

describe('SalesPortalDocumentsPage', () => {
  beforeEach(() => {
    mockUseParams.mockReturnValue({ slug: ['acme-corp', 'portal'] })
    mockUsePathname.mockReturnValue('/acme-corp/portal/orders')
    mockApiCall.mockReset()
  })

  it('builds order detail links from pathname org slug when catch-all params omit orgSlug', async () => {
    mockApiCall.mockResolvedValue({
      ok: true,
      result: {
        ok: true,
        orders: [
          {
            id: '74edf16e-758e-4c1a-83b1-b37aa6e28305',
            orderNumber: 'EPC-DEMO-O-2008',
            status: 'confirmed',
            fulfillmentStatus: 'scheduled',
            paymentStatus: 'unpaid',
            placedAt: '2026-06-16T00:00:00.000Z',
            lineItemCount: 2,
            grandTotalGrossAmount: '1234.56',
            currencyCode: 'GBP',
            createdAt: '2026-06-16T00:00:00.000Z',
            updatedAt: '2026-06-16T00:00:00.000Z',
          },
        ],
        total: 1,
        totalPages: 1,
        page: 1,
        pageSize: 25,
      },
    })

    render(<SalesPortalDocumentsPage kind="orders" />)

    const link = await screen.findByRole('link', { name: 'EPC-DEMO-O-2008' })
    expect(link).toHaveAttribute('href', '/acme-corp/portal/orders/74edf16e-758e-4c1a-83b1-b37aa6e28305')
    expect(link.getAttribute('href')).not.toMatch(/^\/\/portal/)
    await waitFor(() => {
      expect(mockApiCall).toHaveBeenCalledWith('/api/sales/portal/orders?page=1&pageSize=25')
    })
  })

  it('builds quote detail links from pathname org slug when catch-all params omit orgSlug', async () => {
    mockUsePathname.mockReturnValue('/acme-corp/portal/quotes')
    mockApiCall.mockResolvedValue({
      ok: true,
      result: {
        ok: true,
        quotes: [
          {
            id: 'ac6ad511-4baa-44bf-8321-ce05e80c2475',
            quoteNumber: 'EPC-DEMO-Q-1012',
            status: 'sent',
            validUntil: '2026-07-16T00:00:00.000Z',
            lineItemCount: 3,
            grandTotalGrossAmount: '9876.54',
            currencyCode: 'GBP',
            createdAt: '2026-06-16T00:00:00.000Z',
            updatedAt: '2026-06-16T00:00:00.000Z',
          },
        ],
        total: 1,
        totalPages: 1,
        page: 1,
        pageSize: 25,
      },
    })

    render(<SalesPortalDocumentsPage kind="quotes" />)

    const link = await screen.findByRole('link', { name: 'EPC-DEMO-Q-1012' })
    expect(link).toHaveAttribute('href', '/acme-corp/portal/quotes/ac6ad511-4baa-44bf-8321-ce05e80c2475')
    expect(link.getAttribute('href')).not.toMatch(/^\/\/portal/)
    await waitFor(() => {
      expect(mockApiCall).toHaveBeenCalledWith('/api/sales/portal/quotes?page=1&pageSize=25')
    })
  })
})
