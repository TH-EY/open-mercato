"use client"

import * as React from 'react'
import Link from 'next/link'
import { useParams, usePathname } from 'next/navigation'
import { AlertCircle, ArrowLeft, CheckCircle2, FileText, ShoppingBag } from 'lucide-react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { useConfirmDialog } from '@open-mercato/ui/backend/confirm-dialog'
import { PortalPageHeader } from '@open-mercato/ui/portal/components/PortalPageHeader'
import { PortalCard, PortalCardHeader, PortalStatRow, PortalCardDivider } from '@open-mercato/ui/portal/components/PortalCard'
import { PortalEmptyState } from '@open-mercato/ui/portal/components/PortalEmptyState'
import { Button } from '@open-mercato/ui/primitives/button'
import { Spinner } from '@open-mercato/ui/primitives/spinner'

type DocumentKind = 'orders' | 'quotes'

type PortalLine = {
  id: string
  lineNumber: number
  kind: string
  status: string | null
  name: string | null
  description: string | null
  comment: string | null
  quantity: string
  quantityUnit: string | null
  unitPriceNet: string
  unitPriceGross: string
  discountAmount: string
  taxRate: string
  taxAmount: string
  totalNetAmount: string
  totalGrossAmount: string
  currencyCode: string | null
}

type PortalOrderDetail = {
  id: string
  orderNumber: string
  status: string | null
  fulfillmentStatus: string | null
  paymentStatus: string | null
  placedAt: string | null
  expectedDeliveryAt: string | null
  externalReference: string | null
  customerReference: string | null
  comments: string | null
  subtotalNetAmount: string
  subtotalGrossAmount: string
  discountTotalAmount: string
  taxTotalAmount: string
  shippingNetAmount: string
  shippingGrossAmount: string
  surchargeTotalAmount: string
  grandTotalNetAmount: string
  grandTotalGrossAmount: string
  paidTotalAmount: string
  refundedTotalAmount: string
  outstandingAmount: string
  currencyCode: string | null
  lines: PortalLine[]
}

type PortalQuoteDetail = {
  id: string
  quoteNumber: string
  status: string | null
  validFrom: string | null
  validUntil: string | null
  convertedOrderId: string | null
  externalReference: string | null
  customerReference: string | null
  comments: string | null
  subtotalNetAmount: string
  subtotalGrossAmount: string
  discountTotalAmount: string
  taxTotalAmount: string
  grandTotalNetAmount: string
  grandTotalGrossAmount: string
  currencyCode: string | null
  canAccept: boolean
  acceptanceBlockedReason: string | null
  lines: PortalLine[]
}

type PortalOrderDetailResponse = {
  ok: true
  order: PortalOrderDetail
}

type PortalQuoteDetailResponse = {
  ok: true
  quote: PortalQuoteDetail
}

type PortalAcceptResponse = {
  ok: true
  orderId: string
  orderNumber: string
}

type SalesPortalDocumentDetailPageProps = {
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

function readRouteParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? ''
  return value ?? ''
}

function readPathSegment(pathname: string, kind: DocumentKind, segment: 'orgSlug' | 'id'): string {
  const parts = pathname.split('/').filter(Boolean)
  if (segment === 'orgSlug') return parts[0] ?? ''
  const markerIndex = parts.findIndex((part, index) => part === kind && parts[index - 1] === 'portal')
  return markerIndex >= 0 ? parts[markerIndex + 1] ?? '' : ''
}

function StatusPill({ value }: { value: string | null | undefined }) {
  return (
    <span className="inline-flex min-h-6 max-w-full items-center rounded-full border bg-background px-2 py-0.5 text-xs font-medium text-muted-foreground">
      <span className="truncate">{statusLabel(value)}</span>
    </span>
  )
}

function DetailStatGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-x-8 sm:grid-cols-2 lg:grid-cols-3">{children}</div>
}

function LinesTable({ lines, currencyCode }: { lines: PortalLine[]; currencyCode: string | null }) {
  const t = useT()

  if (lines.length === 0) {
    return (
      <PortalEmptyState
        icon={<FileText className="size-5" aria-hidden />}
        title={t('sales.portal.detail.lines.empty.title', 'No line items')}
        description={t('sales.portal.detail.lines.empty.description', 'Line items linked to this document will appear here.')}
      />
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[820px] text-left text-sm">
        <thead className="border-b bg-muted/30 text-xs uppercase text-muted-foreground">
          <tr>
            <th scope="col" className="px-4 py-3 font-medium">{t('sales.portal.detail.lines.columns.item', 'Item')}</th>
            <th scope="col" className="px-4 py-3 text-right font-medium">{t('sales.portal.detail.lines.columns.quantity', 'Qty')}</th>
            <th scope="col" className="px-4 py-3 text-right font-medium">{t('sales.portal.detail.lines.columns.unit', 'Unit')}</th>
            <th scope="col" className="px-4 py-3 text-right font-medium">{t('sales.portal.detail.lines.columns.tax', 'Tax')}</th>
            <th scope="col" className="px-4 py-3 text-right font-medium">{t('sales.portal.detail.lines.columns.total', 'Total')}</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {lines.map((line) => (
            <tr key={line.id} className="bg-card align-top">
              <td className="px-4 py-3">
                <div className="font-medium text-foreground">{line.name || t('sales.portal.detail.lines.untitled', 'Untitled item')}</div>
                {line.description ? <div className="mt-1 max-w-xl text-xs text-muted-foreground">{line.description}</div> : null}
                {line.comment ? <div className="mt-1 max-w-xl text-xs text-muted-foreground">{line.comment}</div> : null}
              </td>
              <td className="px-4 py-3 text-right text-muted-foreground">
                {line.quantity} {line.quantityUnit ?? ''}
              </td>
              <td className="px-4 py-3 text-right text-muted-foreground">
                {formatMoney(line.unitPriceGross, line.currencyCode ?? currencyCode)}
              </td>
              <td className="px-4 py-3 text-right text-muted-foreground">
                {line.taxRate}% / {formatMoney(line.taxAmount, line.currencyCode ?? currencyCode)}
              </td>
              <td className="px-4 py-3 text-right font-medium">
                {formatMoney(line.totalGrossAmount, line.currencyCode ?? currencyCode)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function SalesPortalDocumentDetailPage({ kind }: SalesPortalDocumentDetailPageProps) {
  const t = useT()
  const params = useParams()
  const pathname = usePathname()
  const isOrders = kind === 'orders'
  const id = readRouteParam(params?.id) || readPathSegment(pathname, kind, 'id')
  const orgSlug = readRouteParam(params?.orgSlug) || readPathSegment(pathname, kind, 'orgSlug')
  const [document, setDocument] = React.useState<PortalOrderDetail | PortalQuoteDetail | null>(null)
  const [isLoading, setIsLoading] = React.useState(true)
  const [isAccepting, setIsAccepting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [acceptResult, setAcceptResult] = React.useState<PortalAcceptResponse | null>(null)
  const { confirm, ConfirmDialogElement } = useConfirmDialog()

  const backHref = `/${orgSlug}/portal/${kind}`

  const loadDocument = React.useCallback(async () => {
    if (!id) return
    setIsLoading(true)
    setError(null)
    try {
      const { ok, result } = await apiCall<PortalOrderDetailResponse | PortalQuoteDetailResponse>(`/api/sales/portal/${kind}/${id}`)
      if (!ok || !result?.ok) {
        setDocument(null)
        setError(t('sales.portal.detail.error.load', 'Failed to load document.'))
        return
      }
      setDocument(isOrders && 'order' in result ? result.order : !isOrders && 'quote' in result ? result.quote : null)
    } catch {
      setDocument(null)
      setError(t('sales.portal.detail.error.load', 'Failed to load document.'))
    } finally {
      setIsLoading(false)
    }
  }, [id, isOrders, kind, t])

  React.useEffect(() => {
    void loadDocument()
  }, [loadDocument])

  const handleAcceptQuote = React.useCallback(async () => {
    if (!document || isOrders || !('quoteNumber' in document)) return
    const confirmed = await confirm({
      title: t('sales.portal.quotes.accept.confirm.title', 'Accept quote?'),
      text: t(
        'sales.portal.quotes.accept.confirm.description',
        'Accepting quote {{number}} for {{total}} will create an order for your company.',
        { number: document.quoteNumber, total: formatMoney(document.grandTotalGrossAmount, document.currencyCode) },
      ),
      confirmText: t('sales.portal.quotes.accept.confirm.action', 'Accept quote'),
      cancelText: t('sales.portal.quotes.accept.confirm.cancel', 'Cancel'),
    })
    if (!confirmed) return

    setIsAccepting(true)
    setError(null)
    try {
      const { ok, result } = await apiCall<PortalAcceptResponse>(`/api/sales/portal/quotes/${document.id}/accept`, {
        method: 'POST',
      })
      if (!ok || !result?.ok) {
        setError(t('sales.portal.quotes.accept.error', 'Failed to accept quote.'))
        return
      }
      setAcceptResult(result)
      await loadDocument()
    } catch {
      setError(t('sales.portal.quotes.accept.error', 'Failed to accept quote.'))
    } finally {
      setIsAccepting(false)
    }
  }, [confirm, document, isOrders, loadDocument, t])

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Spinner />
      </div>
    )
  }

  if (error && !document) {
    return (
      <PortalEmptyState
        icon={<AlertCircle className="size-5" aria-hidden />}
        title={t('sales.portal.detail.error.title', 'Unable to load document')}
        description={error}
        action={(
          <Button asChild variant="outline">
            <Link href={backHref}>
              <ArrowLeft className="mr-2 size-4" aria-hidden />
              {t('sales.portal.detail.back', 'Back')}
            </Link>
          </Button>
        )}
      />
    )
  }

  if (!document) {
    return null
  }

  const number = isOrders && 'orderNumber' in document ? document.orderNumber : !isOrders && 'quoteNumber' in document ? document.quoteNumber : ''
  const title = isOrders
    ? t('sales.portal.orders.detail.title', 'Order {{number}}', { number })
    : t('sales.portal.quotes.detail.title', 'Quote {{number}}', { number })
  const createdDate = isOrders && 'placedAt' in document ? document.placedAt : !isOrders && 'validUntil' in document ? document.validUntil : null
  const canAccept = !isOrders && 'canAccept' in document && document.canAccept

  return (
    <div className="flex flex-col gap-6">
      {ConfirmDialogElement}
      <PortalPageHeader
        title={title}
        description={isOrders
          ? t('sales.portal.orders.detail.description', 'Review order status, totals, and line items.')
          : t('sales.portal.quotes.detail.description', 'Review quote details and accept it when you are ready.')}
        label={t('sales.portal.label', 'Sales')}
        action={(
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild type="button" variant="outline">
              <Link href={backHref}>
                <ArrowLeft className="mr-2 size-4" aria-hidden />
                {t('sales.portal.detail.back', 'Back')}
              </Link>
            </Button>
            {canAccept ? (
              <Button type="button" onClick={() => { void handleAcceptQuote() }} disabled={isAccepting}>
                {isAccepting ? <Spinner className="mr-2 size-4" /> : <CheckCircle2 className="mr-2 size-4" aria-hidden />}
                {t('sales.portal.quotes.accept.action', 'Accept quote')}
              </Button>
            ) : null}
          </div>
        )}
      />

      {acceptResult ? (
        <PortalCard className="border-green-500/30 bg-green-500/10">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="font-medium text-foreground">{t('sales.portal.quotes.accept.success.title', 'Quote accepted')}</div>
              <div className="mt-1 text-sm text-muted-foreground">
                {t('sales.portal.quotes.accept.success.description', 'Order {{number}} has been created.', { number: acceptResult.orderNumber })}
              </div>
            </div>
            <Button asChild type="button" variant="outline">
              <Link href={`/${orgSlug}/portal/orders/${acceptResult.orderId}`}>
                <ShoppingBag className="mr-2 size-4" aria-hidden />
                {t('sales.portal.quotes.accept.success.viewOrder', 'View order')}
              </Link>
            </Button>
          </div>
        </PortalCard>
      ) : null}

      {error ? (
        <PortalCard className="border-destructive/30 bg-destructive/10">
          <div className="text-sm text-destructive">{error}</div>
        </PortalCard>
      ) : null}

      <PortalCard>
        <PortalCardHeader
          title={t('sales.portal.detail.summary.title', 'Summary')}
          description={t('sales.portal.detail.summary.description', 'Document status and key dates.')}
        />
        <DetailStatGrid>
          <PortalStatRow label={t('sales.portal.documents.columns.status', 'Status')} value={<StatusPill value={document.status} />} />
          {isOrders && 'fulfillmentStatus' in document ? (
            <PortalStatRow label={t('sales.portal.orders.columns.fulfillment', 'Fulfillment')} value={<StatusPill value={document.fulfillmentStatus} />} />
          ) : null}
          {isOrders && 'paymentStatus' in document ? (
            <PortalStatRow label={t('sales.portal.orders.columns.payment', 'Payment')} value={<StatusPill value={document.paymentStatus} />} />
          ) : null}
          <PortalStatRow
            label={isOrders ? t('sales.portal.orders.columns.date', 'Placed') : t('sales.portal.quotes.columns.validUntil', 'Valid until')}
            value={formatDate(createdDate)}
          />
          <PortalStatRow label={t('sales.portal.documents.columns.items', 'Items')} value={document.lines.length} />
          <PortalStatRow label={t('sales.portal.documents.columns.total', 'Total')} value={formatMoney(document.grandTotalGrossAmount, document.currencyCode)} />
        </DetailStatGrid>
      </PortalCard>

      <PortalCard className="p-0 sm:p-0">
        <div className="p-5 sm:p-6">
          <PortalCardHeader
            title={t('sales.portal.detail.lines.title', 'Line items')}
            description={t('sales.portal.detail.lines.description', 'Items included in this document.')}
          />
        </div>
        <LinesTable lines={document.lines} currencyCode={document.currencyCode} />
      </PortalCard>

      <PortalCard>
        <PortalCardHeader title={t('sales.portal.detail.totals.title', 'Totals')} />
        <div className="max-w-xl">
          <PortalStatRow label={t('sales.portal.detail.totals.subtotalNet', 'Subtotal net')} value={formatMoney(document.subtotalNetAmount, document.currencyCode)} />
          <PortalCardDivider />
          <PortalStatRow label={t('sales.portal.detail.totals.subtotalGross', 'Subtotal gross')} value={formatMoney(document.subtotalGrossAmount, document.currencyCode)} />
          <PortalCardDivider />
          <PortalStatRow label={t('sales.portal.detail.totals.discount', 'Discount')} value={formatMoney(document.discountTotalAmount, document.currencyCode)} />
          <PortalCardDivider />
          <PortalStatRow label={t('sales.portal.detail.totals.tax', 'Tax')} value={formatMoney(document.taxTotalAmount, document.currencyCode)} />
          {isOrders && 'shippingGrossAmount' in document ? (
            <>
              <PortalCardDivider />
              <PortalStatRow label={t('sales.portal.detail.totals.shipping', 'Shipping')} value={formatMoney(document.shippingGrossAmount, document.currencyCode)} />
            </>
          ) : null}
          <PortalCardDivider />
          <PortalStatRow label={t('sales.portal.detail.totals.grand', 'Grand total')} value={formatMoney(document.grandTotalGrossAmount, document.currencyCode)} />
        </div>
      </PortalCard>

      <PortalCard>
        <PortalCardHeader title={t('sales.portal.detail.references.title', 'References and notes')} />
        <div className="space-y-1">
          <PortalStatRow label={t('sales.portal.detail.references.external', 'External reference')} value={document.externalReference || '-'} />
          <PortalCardDivider />
          <PortalStatRow label={t('sales.portal.detail.references.customer', 'Customer reference')} value={document.customerReference || '-'} />
        </div>
        {document.comments ? (
          <div className="mt-4 rounded-md border bg-background p-4 text-sm text-muted-foreground">
            {document.comments}
          </div>
        ) : null}
      </PortalCard>
    </div>
  )
}
