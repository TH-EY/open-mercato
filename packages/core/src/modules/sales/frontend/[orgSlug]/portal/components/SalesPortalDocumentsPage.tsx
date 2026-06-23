"use client"

import * as React from 'react'
import Link from 'next/link'
import { useParams, usePathname } from 'next/navigation'
import { AlertCircle, FileText, Search, ShoppingBag } from 'lucide-react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { PortalPageHeader } from '@open-mercato/ui/portal/components/PortalPageHeader'
import { PortalEmptyState } from '@open-mercato/ui/portal/components/PortalEmptyState'
import { PortalCard } from '@open-mercato/ui/portal/components/PortalCard'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { Spinner } from '@open-mercato/ui/primitives/spinner'

type DocumentKind = 'orders' | 'quotes'

type PortalDocumentRow = {
  id: string
  orderNumber?: string
  quoteNumber?: string
  status: string | null
  fulfillmentStatus?: string | null
  paymentStatus?: string | null
  placedAt?: string | null
  expectedDeliveryAt?: string | null
  validFrom?: string | null
  validUntil?: string | null
  convertedOrderId?: string | null
  lineItemCount: number
  grandTotalGrossAmount: string
  outstandingAmount?: string
  currencyCode: string | null
  createdAt: string
  updatedAt: string
}

type PortalOrdersResponse = {
  ok: true
  orders: PortalDocumentRow[]
  total: number
  totalPages: number
  page: number
  pageSize: number
}

type PortalQuotesResponse = {
  ok: true
  quotes: PortalDocumentRow[]
  total: number
  totalPages: number
  page: number
  pageSize: number
}

type PortalDocumentsErrorResponse = {
  ok: false
  error?: string
}

type PortalDocumentsResponse = PortalOrdersResponse | PortalQuotesResponse | PortalDocumentsErrorResponse

type SalesPortalDocumentsPageProps = {
  kind: DocumentKind
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date)
}

function formatMoney(amount: string | undefined, currencyCode: string | null): string {
  const parsed = Number(amount ?? '0')
  const value = Number.isNaN(parsed) ? 0 : parsed
  if (!currencyCode) return value.toFixed(2)
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currencyCode }).format(value)
  } catch {
    return `${value.toFixed(2)} ${currencyCode}`
  }
}

function statusLabel(value: string | null | undefined): string {
  if (!value) return '-'
  return value
    .split(/[_-]/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ')
}

function StatusPill({ value }: { value: string | null | undefined }) {
  return (
    <span className="inline-flex min-h-6 max-w-full items-center rounded-full border bg-background px-2 py-0.5 text-xs font-medium text-muted-foreground">
      <span className="truncate">{statusLabel(value)}</span>
    </span>
  )
}

function readRows(kind: DocumentKind, data: PortalDocumentsResponse | undefined): PortalDocumentRow[] {
  if (!data?.ok) return []
  if (kind === 'orders' && 'orders' in data) return data.orders
  if (kind === 'quotes' && 'quotes' in data) return data.quotes
  return []
}

function readLoadError(
  status: number,
  data: PortalDocumentsResponse | null,
  t: ReturnType<typeof useT>,
): string {
  if (data && !data.ok && data.error === 'No company association') {
    return t(
      'sales.portal.documents.error.companyAssociation',
      'This portal account is not linked to a company yet. Ask your administrator to link it to the customer company before viewing orders and quotes.',
    )
  }
  if (status === 403) {
    return t('sales.portal.documents.error.forbidden', 'You do not have access to these documents.')
  }
  return t('sales.portal.documents.error.load', 'Failed to load documents.')
}

function readRouteParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? ''
  return value ?? ''
}

function readOrgSlugFromPathname(pathname: string): string {
  const parts = pathname.split('/').filter(Boolean)
  return parts[0] ?? ''
}

export function SalesPortalDocumentsPage({ kind }: SalesPortalDocumentsPageProps) {
  const t = useT()
  const params = useParams()
  const pathname = usePathname()
  const orgSlug = readRouteParam(params?.orgSlug) || readOrgSlugFromPathname(pathname)
  const [rows, setRows] = React.useState<PortalDocumentRow[]>([])
  const [page, setPage] = React.useState(1)
  const [totalPages, setTotalPages] = React.useState(1)
  const [total, setTotal] = React.useState(0)
  const [searchInput, setSearchInput] = React.useState('')
  const [search, setSearch] = React.useState('')
  const [isLoading, setIsLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  const isOrders = kind === 'orders'
  const pageTitle = isOrders
    ? t('sales.portal.orders.title', 'Orders')
    : t('sales.portal.quotes.title', 'Quotes')
  const pageDescription = isOrders
    ? t('sales.portal.orders.description', 'Review your company order history.')
    : t('sales.portal.quotes.description', 'Review quotes received by your company.')
  const emptyTitle = isOrders
    ? t('sales.portal.orders.empty.title', 'No orders yet')
    : t('sales.portal.quotes.empty.title', 'No quotes yet')
  const emptyDescription = isOrders
    ? t('sales.portal.orders.empty.description', 'Orders linked to your company will appear here.')
    : t('sales.portal.quotes.empty.description', 'Quotes linked to your company will appear here.')
  const pageSize = 25

  React.useEffect(() => {
    let cancelled = false

    async function loadDocuments() {
      setIsLoading(true)
      setError(null)
      const params = new URLSearchParams()
      params.set('page', String(page))
      params.set('pageSize', String(pageSize))
      if (search.trim()) params.set('search', search.trim())

      try {
        const { ok, status, result } = await apiCall<PortalDocumentsResponse>(
          `/api/sales/portal/${kind}?${params.toString()}`,
        )
        if (cancelled) return
        if (!ok || !result?.ok) {
          setRows([])
          setTotal(0)
          setTotalPages(1)
          setError(readLoadError(status, result, t))
          return
        }
        setRows(readRows(kind, result))
        setTotal(result.total)
        setTotalPages(result.totalPages)
      } catch {
        if (!cancelled) {
          setRows([])
          setTotal(0)
          setTotalPages(1)
          setError(t('sales.portal.documents.error.load', 'Failed to load documents.'))
        }
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }

    void loadDocuments()
    return () => { cancelled = true }
  }, [kind, page, pageSize, search, t])

  const handleSearch = React.useCallback((event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setPage(1)
    setSearch(searchInput)
  }, [searchInput])

  return (
    <div className="flex flex-col gap-6">
      <PortalPageHeader title={pageTitle} description={pageDescription} label={t('sales.portal.label', 'Sales')} />

      <PortalCard className="p-0 sm:p-0">
        <div className="flex flex-col gap-3 border-b p-4 sm:flex-row sm:items-center sm:justify-between">
          <form onSubmit={handleSearch} className="flex w-full max-w-md items-center gap-2">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                className="pl-9"
                placeholder={isOrders
                  ? t('sales.portal.orders.search', 'Search orders')
                  : t('sales.portal.quotes.search', 'Search quotes')}
              />
            </div>
            <Button type="submit" variant="outline">
              {t('sales.portal.documents.searchAction', 'Search')}
            </Button>
          </form>
          <div className="text-sm text-muted-foreground">
            {t('sales.portal.documents.total', 'Total')}: {total}
          </div>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Spinner />
          </div>
        ) : error ? (
          <div className="p-6">
            <PortalEmptyState
              icon={<AlertCircle className="size-5" aria-hidden />}
              title={t('sales.portal.documents.error.title', 'Unable to load documents')}
              description={error}
            />
          </div>
        ) : rows.length === 0 ? (
          <div className="p-6">
            <PortalEmptyState
              icon={isOrders ? <ShoppingBag className="size-5" aria-hidden /> : <FileText className="size-5" aria-hidden />}
              title={emptyTitle}
              description={emptyDescription}
            />
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead className="border-b bg-muted/30 text-xs uppercase text-muted-foreground">
                  <tr>
                    <th scope="col" className="px-4 py-3 font-medium">
                      {isOrders ? t('sales.portal.orders.columns.number', 'Order') : t('sales.portal.quotes.columns.number', 'Quote')}
                    </th>
                    <th scope="col" className="px-4 py-3 font-medium">
                      {t('sales.portal.documents.columns.status', 'Status')}
                    </th>
                    {isOrders ? (
                      <>
                        <th scope="col" className="px-4 py-3 font-medium">
                          {t('sales.portal.orders.columns.fulfillment', 'Fulfillment')}
                        </th>
                        <th scope="col" className="px-4 py-3 font-medium">
                          {t('sales.portal.orders.columns.payment', 'Payment')}
                        </th>
                      </>
                    ) : null}
                    <th scope="col" className="px-4 py-3 font-medium">
                      {isOrders ? t('sales.portal.orders.columns.date', 'Placed') : t('sales.portal.quotes.columns.validUntil', 'Valid until')}
                    </th>
                    <th scope="col" className="px-4 py-3 text-right font-medium">
                      {t('sales.portal.documents.columns.items', 'Items')}
                    </th>
                    <th scope="col" className="px-4 py-3 text-right font-medium">
                      {t('sales.portal.documents.columns.total', 'Total')}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {rows.map((row) => (
                    <tr key={row.id} className="bg-card">
                      <td className="px-4 py-3 font-medium text-foreground">
                        <Link
                          href={orgSlug ? `/${orgSlug}/portal/${kind}/${row.id}` : `/portal/${kind}/${row.id}`}
                          className="underline-offset-4 hover:underline"
                        >
                          {isOrders ? row.orderNumber : row.quoteNumber}
                        </Link>
                      </td>
                      <td className="px-4 py-3">
                        <StatusPill value={row.status} />
                      </td>
                      {isOrders ? (
                        <>
                          <td className="px-4 py-3">
                            <StatusPill value={row.fulfillmentStatus} />
                          </td>
                          <td className="px-4 py-3">
                            <StatusPill value={row.paymentStatus} />
                          </td>
                        </>
                      ) : null}
                      <td className="px-4 py-3 text-muted-foreground">
                        {isOrders ? formatDate(row.placedAt ?? row.createdAt) : formatDate(row.validUntil)}
                      </td>
                      <td className="px-4 py-3 text-right text-muted-foreground">
                        {row.lineItemCount}
                      </td>
                      <td className="px-4 py-3 text-right font-medium">
                        {formatMoney(row.grandTotalGrossAmount, row.currencyCode)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex items-center justify-between gap-3 border-t p-4">
              <span className="text-sm text-muted-foreground">
                {t('sales.portal.documents.page', 'Page')} {page} / {totalPages}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={page <= 1}
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                >
                  {t('sales.portal.documents.previous', 'Previous')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={page >= totalPages}
                  onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                >
                  {t('sales.portal.documents.next', 'Next')}
                </Button>
              </div>
            </div>
          </>
        )}
      </PortalCard>
    </div>
  )
}
