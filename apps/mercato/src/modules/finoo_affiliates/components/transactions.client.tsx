"use client"

import * as React from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { useOrganizationScopeVersion } from '@open-mercato/shared/lib/frontend/useOrganizationScope'
import { Page, PageBody, PageHeader } from '@open-mercato/ui/backend/Page'
import { DataTable } from '@open-mercato/ui/backend/DataTable'
import { apiCall, readApiResultOrThrow, withScopedApiRequestHeaders } from '@open-mercato/ui/backend/utils/apiCall'
import { raiseCrudError } from '@open-mercato/ui/backend/utils/serverErrors'
import { buildOptimisticLockHeader } from '@open-mercato/ui/backend/utils/optimisticLock'
import { surfaceRecordConflict } from '@open-mercato/ui/backend/conflicts'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { Button } from '@open-mercato/ui/primitives/button'
import { StatusBadge } from '@open-mercato/ui/primitives/status-badge'
import { ListEmptyState } from '@open-mercato/ui/backend/filters/ListEmptyState'
import PayoutPreviewDialog, { type PayoutPreview } from './payout-preview-dialog.client'

type TransactionStatus = 'processing' | 'approved' | 'rejected' | 'paid_out'
type TransactionAction = 'accept' | 'reject' | 'reprocess'
type TransactionRow = {
  id: string
  affiliateFirstName: string
  affiliateLastName: string
  dealName: string | null
  dealCompany: string | null
  commissionAmount: number
  currency: string
  commissionStatus: TransactionStatus
  acceptedAt: string
  updatedAt: string
}
type TransactionsResponse = { items: TransactionRow[]; total: number; page: number; pageSize: number }

function legalActions(status: TransactionStatus): TransactionAction[] {
  if (status === 'processing') return ['accept', 'reject']
  if (status === 'rejected') return ['reprocess']
  return []
}

export default function TransactionsClient() {
  const t = useT()
  const scopeVersion = useOrganizationScopeVersion()
  const [rows, setRows] = React.useState<TransactionRow[]>([])
  const [page, setPage] = React.useState(1)
  const [pageSize, setPageSize] = React.useState(25)
  const [total, setTotal] = React.useState(0)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [busyId, setBusyId] = React.useState<string | null>(null)
  const [reloadToken, setReloadToken] = React.useState(0)
  const [payoutPreview, setPayoutPreview] = React.useState<PayoutPreview | null>(null)
  const payoutResolver = React.useRef<((result: { ok: boolean; progressJobId?: string }) => void) | null>(null)
  const { runMutation, retryLastMutation } = useGuardedMutation({ contextId: 'finoo-affiliate-transactions' })

  React.useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) })
    void readApiResultOrThrow<TransactionsResponse>(`/api/finoo_affiliates/transactions?${params.toString()}`)
      .then((payload) => {
        if (!cancelled) {
          setRows(payload.items)
          setTotal(payload.total)
        }
      })
      .catch(() => {
        if (!cancelled) setError(t('finooAffiliates.transactions.loadError', 'Unable to load affiliate transactions.'))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [page, pageSize, reloadToken, scopeVersion, t])

  const transition = React.useCallback(async (row: TransactionRow, action: TransactionAction) => {
    const payload = { action, updatedAt: row.updatedAt }
    setBusyId(row.id)
    try {
      await runMutation({
        operation: async () => {
          const call = await withScopedApiRequestHeaders(
            buildOptimisticLockHeader(row.updatedAt),
            () => apiCall(`/api/finoo_affiliates/transactions/${row.id}/transition`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(payload),
            }),
          )
          if (!call.ok) await raiseCrudError(call.response, t('finooAffiliates.transactions.transitionError', 'Unable to update the transaction.'))
          return call.result ?? {}
        },
        context: { recordId: row.id, retryLastMutation },
        mutationPayload: payload,
      })
      flash(t('finooAffiliates.transactions.transitionSuccess', 'Transaction updated.'), 'success')
      setReloadToken((token) => token + 1)
    } catch (caught) {
      if (!surfaceRecordConflict(caught, t)) {
        flash(t('finooAffiliates.transactions.transitionError', 'Unable to update the transaction.'), 'error')
      }
    } finally {
      setBusyId(null)
    }
  }, [retryLastMutation, runMutation, t])

  const columns = React.useMemo<ColumnDef<TransactionRow>[]>(() => [
    { accessorKey: 'affiliateFirstName', header: t('finooAffiliates.transactions.affiliateFirstName', 'Affiliate first name') },
    { accessorKey: 'affiliateLastName', header: t('finooAffiliates.transactions.affiliateLastName', 'Affiliate last name') },
    { accessorKey: 'dealName', header: t('finooAffiliates.transactions.dealName', 'Deal name') },
    { accessorKey: 'dealCompany', header: t('finooAffiliates.transactions.dealCompany', 'Deal company') },
    {
      accessorKey: 'commissionAmount',
      header: t('finooAffiliates.transactions.amount', 'Commission amount'),
      cell: ({ row }) => `${row.original.commissionAmount.toLocaleString()} ${row.original.currency}`,
    },
    {
      accessorKey: 'commissionStatus',
      header: t('finooAffiliates.transactions.status', 'Commission status'),
      cell: ({ row }) => (
        <StatusBadge variant={row.original.commissionStatus === 'rejected' ? 'error' : row.original.commissionStatus === 'approved' || row.original.commissionStatus === 'paid_out' ? 'success' : 'warning'}>
          {t(`finooAffiliates.transactions.statuses.${row.original.commissionStatus}`, row.original.commissionStatus)}
        </StatusBadge>
      ),
    },
    {
      id: 'actions',
      header: t('finooAffiliates.transactions.actions', 'Actions'),
      cell: ({ row }) => (
        <div className="flex flex-wrap gap-2">
          {legalActions(row.original.commissionStatus).map((action) => (
            <Button
              key={action}
              type="button"
              size="sm"
              variant={action === 'reject' ? 'outline' : 'default'}
              disabled={busyId === row.original.id}
              onClick={() => { void transition(row.original, action) }}
            >
              {t(`finooAffiliates.transactions.actions.${action}`, action)}
            </Button>
          ))}
        </div>
      ),
      enableSorting: false,
    },
  ], [busyId, t, transition])

  const payOut = React.useCallback(async (selected: TransactionRow[]) => {
    if (selected.some((row) => row.commissionStatus !== 'approved')) throw new Error(t('finooAffiliates.payouts.approvedOnly', 'Only approved transactions can be paid out.'))
    const payload = { transactions: selected.map(({ id, updatedAt }) => ({ id, updatedAt })) }
    const preview = await runMutation({
      operation: () => readApiResultOrThrow<PayoutPreview>('/api/finoo_affiliates/payouts/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }),
      context: { recordId: selected.map((row) => row.id).sort().join(','), retryLastMutation },
      mutationPayload: payload,
    })
    setPayoutPreview(preview)
    return new Promise<{ ok: boolean; progressJobId?: string }>((resolve) => { payoutResolver.current = resolve })
  }, [retryLastMutation, runMutation, t])

  return (
    <Page>
      <PageHeader title={t('finooAffiliates.transactions.title', 'Affiliate transactions')} />
      <PageBody>
        <DataTable<TransactionRow>
          title={t('finooAffiliates.transactions.title', 'Affiliate transactions')}
          columns={columns}
          data={rows}
          isLoading={loading}
          error={error}
          perspective={{ tableId: 'finoo_affiliates.transactions' }}
          entityId="finoo_affiliates:finoo_affiliate_transaction"
          emptyState={(
            <ListEmptyState
              entityName={t('finooAffiliates.transactions.title', 'Affiliate transactions')}
              title={t('finooAffiliates.transactions.emptyTitle', 'No affiliate transactions yet')}
            />
          )}
          pagination={{
            page,
            pageSize,
            total,
            totalPages: Math.max(1, Math.ceil(total / pageSize)),
            onPageChange: setPage,
            pageSizeOptions: [10, 25, 50, 100],
            onPageSizeChange: (nextPageSize) => { setPageSize(nextPageSize); setPage(1) },
          }}
          bulkActions={[{ id: 'pay-out', label: t('finooAffiliates.payouts.payOut', 'Pay out'), onExecute: payOut }]}
        />
        {payoutPreview ? <PayoutPreviewDialog preview={payoutPreview} onCancel={() => { setPayoutPreview(null); payoutResolver.current?.({ ok: false }); payoutResolver.current = null }} onComplete={(result) => { setPayoutPreview(null); payoutResolver.current?.({ ok: true, progressJobId: result.progressJobId }); payoutResolver.current = null; setReloadToken((token) => token + 1) }} /> : null}
      </PageBody>
    </Page>
  )
}
