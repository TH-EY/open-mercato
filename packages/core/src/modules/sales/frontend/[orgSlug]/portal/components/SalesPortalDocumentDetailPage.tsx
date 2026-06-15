"use client"

import * as React from 'react'
import Link from 'next/link'
import { useParams, usePathname } from 'next/navigation'
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Clock3,
  CreditCard,
  Download,
  ExternalLink,
  FileText,
  MessageSquare,
  Paperclip,
  Send,
  ShoppingBag,
} from 'lucide-react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { PortalPageHeader } from '@open-mercato/ui/portal/components/PortalPageHeader'
import { PortalCard, PortalCardHeader, PortalStatRow, PortalCardDivider } from '@open-mercato/ui/portal/components/PortalCard'
import { PortalEmptyState } from '@open-mercato/ui/portal/components/PortalEmptyState'
import { Button } from '@open-mercato/ui/primitives/button'
import { Checkbox } from '@open-mercato/ui/primitives/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@open-mercato/ui/primitives/dialog'
import { Input } from '@open-mercato/ui/primitives/input'
import { Spinner } from '@open-mercato/ui/primitives/spinner'
import { Textarea } from '@open-mercato/ui/primitives/textarea'

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
  acceptanceAudit: PortalAcceptanceAudit | null
  payment: PortalPayment
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
  acceptanceAudit: PortalAcceptanceAudit | null
  lines: PortalLine[]
}

type PortalAcceptanceAudit = {
  source: string
  acceptedAt: string | null
  acceptedByName: string | null
  acceptedByEmail: string | null
  acceptedByCustomerUserId: string | null
  acceptedTerms: boolean
}

type PortalPayment = {
  outstandingAmount: string
  paidTotalAmount: string
  paymentStatus: string | null
  portalPaymentUrl: string | null
  depositAmount: string | null
  instructions: string | null
}

type PortalAttachment = {
  id: string
  fileName: string
  fileSize: number
  mimeType: string | null
  createdAt: string
  downloadUrl: string
}

type PortalTimelineEntry = {
  id: string
  occurredAt: string
  kind: 'status' | 'action' | 'comment'
  action: string
  actor: {
    id: string | null
    label: string
  }
}

type PortalComment = {
  id: string
  body: string
  authorName: string | null
  authorEmail: string | null
  createdAt: string
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

type PortalAttachmentsResponse = {
  ok: true
  attachments: PortalAttachment[]
}

type PortalTimelineResponse = {
  ok: true
  timeline: PortalTimelineEntry[]
}

type PortalCommentsResponse = {
  ok: true
  comments: PortalComment[]
}

type PortalCommentCreateResponse = {
  ok: true
  comment: PortalComment
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

function formatFileSize(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return '0 B'
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
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

function AttachmentsSection({ attachments }: { attachments: PortalAttachment[] }) {
  const t = useT()
  return (
    <PortalCard>
      <PortalCardHeader
        title={t('sales.portal.detail.attachments.title', 'Attachments')}
        description={t('sales.portal.detail.attachments.description', 'Files shared with this document.')}
      />
      {attachments.length === 0 ? (
        <PortalEmptyState
          icon={<Paperclip className="size-5" aria-hidden />}
          title={t('sales.portal.detail.attachments.empty.title', 'No attachments')}
          description={t('sales.portal.detail.attachments.empty.description', 'Files shared by the team will appear here.')}
        />
      ) : (
        <div className="divide-y rounded-md border bg-background">
          {attachments.map((attachment) => (
            <div key={attachment.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-foreground">{attachment.fileName}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {formatFileSize(attachment.fileSize)} · {formatDate(attachment.createdAt)}
                </div>
              </div>
              <Button asChild type="button" variant="outline" size="sm">
                <a href={attachment.downloadUrl}>
                  <Download className="mr-2 size-4" aria-hidden />
                  {t('sales.portal.detail.attachments.download', 'Download')}
                </a>
              </Button>
            </div>
          ))}
        </div>
      )}
    </PortalCard>
  )
}

function AcceptanceAuditSection({ audit }: { audit: PortalAcceptanceAudit | null }) {
  const t = useT()
  if (!audit) return null
  return (
    <PortalCard className="border-green-500/30 bg-green-500/10">
      <PortalCardHeader
        title={t('sales.portal.detail.acceptance.title', 'Acceptance')}
        description={t('sales.portal.detail.acceptance.description', 'Acceptance captured through the customer portal.')}
      />
      <DetailStatGrid>
        <PortalStatRow label={t('sales.portal.detail.acceptance.by', 'Accepted by')} value={audit.acceptedByName || '-'} />
        <PortalStatRow label={t('sales.portal.detail.acceptance.email', 'Email')} value={audit.acceptedByEmail || '-'} />
        <PortalStatRow label={t('sales.portal.detail.acceptance.at', 'Accepted at')} value={formatDate(audit.acceptedAt)} />
        <PortalStatRow
          label={t('sales.portal.detail.acceptance.terms', 'Terms')}
          value={audit.acceptedTerms ? t('sales.portal.detail.acceptance.termsAccepted', 'Accepted') : '-'}
        />
      </DetailStatGrid>
    </PortalCard>
  )
}

function PaymentPanel({ payment, currencyCode }: { payment: PortalPayment; currencyCode: string | null }) {
  const t = useT()
  return (
    <PortalCard>
      <PortalCardHeader
        title={t('sales.portal.detail.payment.title', 'Payment')}
        description={t('sales.portal.detail.payment.description', 'Payment status and deposit information.')}
      />
      <DetailStatGrid>
        <PortalStatRow label={t('sales.portal.orders.columns.payment', 'Payment')} value={<StatusPill value={payment.paymentStatus} />} />
        <PortalStatRow label={t('sales.portal.detail.payment.paid', 'Paid')} value={formatMoney(payment.paidTotalAmount, currencyCode)} />
        <PortalStatRow label={t('sales.portal.detail.payment.outstanding', 'Outstanding')} value={formatMoney(payment.outstandingAmount, currencyCode)} />
        <PortalStatRow label={t('sales.portal.detail.payment.deposit', 'Deposit')} value={payment.depositAmount ? formatMoney(payment.depositAmount, currencyCode) : '-'} />
      </DetailStatGrid>
      {payment.instructions ? (
        <div className="mt-4 rounded-md border bg-background p-4 text-sm text-muted-foreground">{payment.instructions}</div>
      ) : (
        <div className="mt-4 rounded-md border bg-background p-4 text-sm text-muted-foreground">
          {t('sales.portal.detail.payment.instructionsFallback', 'EPC will confirm any deposit or payment details separately.')}
        </div>
      )}
      {payment.portalPaymentUrl ? (
        <div className="mt-4">
          <Button asChild type="button" variant="outline">
            <a href={payment.portalPaymentUrl} target="_blank" rel="noreferrer">
              <CreditCard className="mr-2 size-4" aria-hidden />
              {t('sales.portal.detail.payment.openLink', 'Open payment link')}
              <ExternalLink className="ml-2 size-4" aria-hidden />
            </a>
          </Button>
        </div>
      ) : null}
    </PortalCard>
  )
}

function TimelineSection({ timeline }: { timeline: PortalTimelineEntry[] }) {
  const t = useT()
  return (
    <PortalCard>
      <PortalCardHeader
        title={t('sales.portal.detail.timeline.title', 'Timeline')}
        description={t('sales.portal.detail.timeline.description', 'Recent order status and activity.')}
      />
      {timeline.length === 0 ? (
        <PortalEmptyState
          icon={<Clock3 className="size-5" aria-hidden />}
          title={t('sales.portal.detail.timeline.empty.title', 'No timeline yet')}
          description={t('sales.portal.detail.timeline.empty.description', 'Order updates will appear here.')}
        />
      ) : (
        <div className="space-y-4">
          {timeline.map((entry) => (
            <div key={entry.id} className="flex gap-3">
              <span className="mt-1 inline-flex size-2 shrink-0 rounded-full bg-accent-indigo" aria-hidden />
              <div className="min-w-0">
                <div className="text-sm font-medium text-foreground">{statusLabel(entry.action)}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {formatDate(entry.occurredAt)} · {entry.actor.label}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </PortalCard>
  )
}

function QuoteCommentsSection({
  comments,
  body,
  isSubmitting,
  onBodyChange,
  onSubmit,
}: {
  comments: PortalComment[]
  body: string
  isSubmitting: boolean
  onBodyChange: (value: string) => void
  onSubmit: () => void
}) {
  const t = useT()
  return (
    <PortalCard>
      <PortalCardHeader
        title={t('sales.portal.detail.comments.title', 'Questions and comments')}
        description={t('sales.portal.detail.comments.description', 'Send a question to the EPC team about this quote.')}
      />
      <div className="space-y-4">
        {comments.length === 0 ? (
          <PortalEmptyState
            icon={<MessageSquare className="size-5" aria-hidden />}
            title={t('sales.portal.detail.comments.empty.title', 'No comments yet')}
            description={t('sales.portal.detail.comments.empty.description', 'Questions sent from the portal will appear here.')}
          />
        ) : (
          <div className="space-y-3">
            {comments.map((comment) => (
              <div key={comment.id} className="rounded-md border bg-background p-4">
                <div className="text-sm text-foreground">{comment.body}</div>
                <div className="mt-2 text-xs text-muted-foreground">
                  {comment.authorName || t('sales.portal.detail.comments.customer', 'Customer')} · {formatDate(comment.createdAt)}
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="space-y-2">
          <Textarea
            value={body}
            maxLength={2000}
            showCount
            placeholder={t('sales.portal.detail.comments.placeholder', 'Ask a question about this quote...')}
            onChange={(event) => onBodyChange(event.target.value)}
          />
          <div className="flex justify-end">
            <Button type="button" onClick={onSubmit} disabled={isSubmitting || body.trim().length === 0}>
              {isSubmitting ? <Spinner className="mr-2 size-4" /> : <Send className="mr-2 size-4" aria-hidden />}
              {t('sales.portal.detail.comments.submit', 'Send comment')}
            </Button>
          </div>
        </div>
      </div>
    </PortalCard>
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
  const [attachments, setAttachments] = React.useState<PortalAttachment[]>([])
  const [timeline, setTimeline] = React.useState<PortalTimelineEntry[]>([])
  const [comments, setComments] = React.useState<PortalComment[]>([])
  const [commentBody, setCommentBody] = React.useState('')
  const [isLoading, setIsLoading] = React.useState(true)
  const [isAccepting, setIsAccepting] = React.useState(false)
  const [isCommentSubmitting, setIsCommentSubmitting] = React.useState(false)
  const [acceptDialogOpen, setAcceptDialogOpen] = React.useState(false)
  const [acceptedByName, setAcceptedByName] = React.useState('')
  const [acceptedTerms, setAcceptedTerms] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [acceptResult, setAcceptResult] = React.useState<PortalAcceptResponse | null>(null)

  const backHref = `/${orgSlug}/portal/${kind}`

  const loadAttachments = React.useCallback(async () => {
    if (!id) return
    const { ok, result } = await apiCall<PortalAttachmentsResponse>(`/api/sales/portal/${kind}/${id}/attachments`)
    setAttachments(ok && result?.ok ? result.attachments : [])
  }, [id, kind])

  const loadTimeline = React.useCallback(async () => {
    if (!id || !isOrders) return
    const { ok, result } = await apiCall<PortalTimelineResponse>(`/api/sales/portal/orders/${id}/timeline`)
    setTimeline(ok && result?.ok ? result.timeline : [])
  }, [id, isOrders])

  const loadComments = React.useCallback(async () => {
    if (!id || isOrders) return
    const { ok, result } = await apiCall<PortalCommentsResponse>(`/api/sales/portal/quotes/${id}/comments`)
    setComments(ok && result?.ok ? result.comments : [])
  }, [id, isOrders])

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
      await Promise.all([
        loadAttachments().catch(() => setAttachments([])),
        loadTimeline().catch(() => setTimeline([])),
        loadComments().catch(() => setComments([])),
      ])
    } catch {
      setDocument(null)
      setError(t('sales.portal.detail.error.load', 'Failed to load document.'))
    } finally {
      setIsLoading(false)
    }
  }, [id, isOrders, kind, loadAttachments, loadComments, loadTimeline, t])

  React.useEffect(() => {
    void loadDocument()
  }, [loadDocument])

  const handleAcceptQuote = React.useCallback(async () => {
    if (!document || isOrders || !('quoteNumber' in document)) return
    if (acceptedByName.trim().length < 2 || !acceptedTerms) {
      setError(t('sales.portal.quotes.accept.validation', 'Accepting a quote requires your name and terms acceptance.'))
      return
    }

    setIsAccepting(true)
    setError(null)
    try {
      const { ok, result } = await apiCall<PortalAcceptResponse>(`/api/sales/portal/quotes/${document.id}/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          acceptedByName: acceptedByName.trim(),
          acceptedTerms,
        }),
      })
      if (!ok || !result?.ok) {
        setError(t('sales.portal.quotes.accept.error', 'Failed to accept quote.'))
        return
      }
      setAcceptResult(result)
      setAcceptDialogOpen(false)
      setDocument((current) => {
        if (!current || isOrders || !('quoteNumber' in current)) return current
        return {
          ...current,
          status: 'confirmed',
          convertedOrderId: result.orderId,
          canAccept: false,
          acceptanceBlockedReason: 'converted',
          acceptanceAudit: {
            source: 'customer_portal',
            acceptedAt: new Date().toISOString(),
            acceptedByName: acceptedByName.trim(),
            acceptedByEmail: null,
            acceptedByCustomerUserId: null,
            acceptedTerms,
          },
        }
      })
      await Promise.all([
        loadComments().catch(() => undefined),
      ])
    } catch {
      setError(t('sales.portal.quotes.accept.error', 'Failed to accept quote.'))
    } finally {
      setIsAccepting(false)
    }
  }, [acceptedByName, acceptedTerms, document, isOrders, loadComments, t])

  const handleCommentSubmit = React.useCallback(async () => {
    if (!document || isOrders || commentBody.trim().length === 0) return
    setIsCommentSubmitting(true)
    setError(null)
    try {
      const { ok, result } = await apiCall<PortalCommentCreateResponse>(`/api/sales/portal/quotes/${document.id}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: commentBody.trim() }),
      })
      if (!ok || !result?.ok) {
        setError(t('sales.portal.detail.comments.error', 'Failed to send comment.'))
        return
      }
      setComments((current) => [...current, result.comment])
      setCommentBody('')
    } catch {
      setError(t('sales.portal.detail.comments.error', 'Failed to send comment.'))
    } finally {
      setIsCommentSubmitting(false)
    }
  }, [commentBody, document, isOrders, t])

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
      <Dialog open={acceptDialogOpen} onOpenChange={setAcceptDialogOpen}>
        <DialogContent>
          <DialogHeader leading={<CheckCircle2 className="size-5" aria-hidden />} leadingTone="success">
            <DialogTitle>{t('sales.portal.quotes.accept.confirm.title', 'Accept quote?')}</DialogTitle>
            <DialogDescription>
              {t(
                'sales.portal.quotes.accept.confirm.description',
                'Accepting quote {{number}} for {{total}} will create an order for your company.',
                {
                  number: !isOrders && 'quoteNumber' in document ? document.quoteNumber : '',
                  total: formatMoney(document.grandTotalGrossAmount, document.currencyCode),
                },
              )}
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault()
              void handleAcceptQuote()
            }}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault()
                void handleAcceptQuote()
              }
            }}
          >
            <label className="block space-y-2 text-sm">
              <span className="font-medium text-foreground">{t('sales.portal.quotes.accept.acceptedByName', 'Name of accepting person')}</span>
              <Input
                value={acceptedByName}
                placeholder={t('sales.portal.quotes.accept.acceptedByName.placeholder', 'Full name')}
                onChange={(event) => setAcceptedByName(event.target.value)}
              />
            </label>
            <label className="flex items-start gap-3 rounded-md border bg-background p-3 text-sm">
              <Checkbox
                checked={acceptedTerms}
                onCheckedChange={(value) => setAcceptedTerms(value === true)}
                aria-label={t('sales.portal.quotes.accept.terms.ariaLabel', 'Accept terms')}
              />
              <span className="text-muted-foreground">
                {t('sales.portal.quotes.accept.terms', 'I accept the terms of this quote and understand that accepting it will create an order.')}
              </span>
            </label>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setAcceptDialogOpen(false)}>
                {t('sales.portal.quotes.accept.confirm.cancel', 'Cancel')}
              </Button>
              <Button type="submit" disabled={isAccepting || acceptedByName.trim().length < 2 || !acceptedTerms}>
                {isAccepting ? <Spinner className="mr-2 size-4" /> : <CheckCircle2 className="mr-2 size-4" aria-hidden />}
                {t('sales.portal.quotes.accept.confirm.action', 'Accept quote')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
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
            <Button asChild type="button" variant="outline">
              <a href={`/api/sales/portal/${kind}/${document.id}/pdf`}>
                <Download className="mr-2 size-4" aria-hidden />
                {t('sales.portal.detail.pdf.download', 'Download PDF')}
              </a>
            </Button>
            {canAccept ? (
              <Button type="button" onClick={() => setAcceptDialogOpen(true)} disabled={isAccepting}>
                <CheckCircle2 className="mr-2 size-4" aria-hidden />
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

      <AcceptanceAuditSection audit={document.acceptanceAudit} />

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

      <AttachmentsSection attachments={attachments} />

      {isOrders && 'payment' in document ? (
        <PaymentPanel payment={document.payment} currencyCode={document.currencyCode} />
      ) : null}

      {isOrders ? (
        <TimelineSection timeline={timeline} />
      ) : (
        <QuoteCommentsSection
          comments={comments}
          body={commentBody}
          isSubmitting={isCommentSubmitting}
          onBodyChange={setCommentBody}
          onSubmit={handleCommentSubmit}
        />
      )}
    </div>
  )
}
