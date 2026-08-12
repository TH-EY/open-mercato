"use client"

import * as React from 'react'
import type { ColumnDef, SortingState } from '@tanstack/react-table'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { DataTable } from '@open-mercato/ui/backend/DataTable'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { PortalPageHeader } from '@open-mercato/ui/portal/components/PortalPageHeader'

type CommissionStatus = 'approved' | 'waiting' | 'rejected'

type LeadRow = {
  id: string
  companyName: string | null
  landingPage: string | null
  initialReferrer: string | null
  commissionStatus: CommissionStatus
  commissionAmount: number
  leadAt: string
}

type LeadsPayload = {
  items: LeadRow[]
  total: number
  page: number
  pageSize: number
}

function ExternalValue({ value }: { value: string | null }) {
  if (!value) return <span className="text-muted-foreground">—</span>
  let href: string | null = null
  try {
    const url = new URL(value)
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      href = url.toString()
    }
  } catch {}
  if (href) {
    return <a href={href} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">{value}</a>
  }
  return <span>{value}</span>
}

export default function AffiliateLeadsPage() {
  const t = useT()
  const [items, setItems] = React.useState<LeadRow[]>([])
  const [total, setTotal] = React.useState(0)
  const [page, setPage] = React.useState(1)
  const [pageSize, setPageSize] = React.useState(25)
  const [sorting, setSorting] = React.useState<SortingState>([{ id: 'leadAt', desc: true }])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    const activeSort = sorting[0]
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(pageSize),
      sortField: activeSort?.id ?? 'leadAt',
      sortDir: activeSort?.desc === false ? 'asc' : 'desc',
    })
    try {
      const payload = await readApiResultOrThrow<LeadsPayload>(`/api/finoo_affiliates/portal/leads?${params.toString()}`)
      setItems(payload.items ?? [])
      setTotal(payload.total ?? 0)
    } catch {
      setError(t('finooAffiliates.portal.leads.loadError', 'Unable to load leads.'))
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, sorting, t])

  React.useEffect(() => {
    void load()
  }, [load])

  const statusLabel = React.useCallback((status: CommissionStatus) => {
    return t(`finooAffiliates.commissionStatus.${status}`, status)
  }, [t])

  const columns = React.useMemo<ColumnDef<LeadRow>[]>(() => [
    {
      accessorKey: 'companyName',
      header: t('finooAffiliates.portal.leads.companyName', 'Company name'),
      cell: ({ row }) => row.original.companyName || '—',
      enableSorting: false,
    },
    {
      accessorKey: 'landingPage',
      header: t('finooAffiliates.portal.leads.landingPage', 'Landing page'),
      cell: ({ row }) => <ExternalValue value={row.original.landingPage} />,
      enableSorting: false,
    },
    {
      accessorKey: 'initialReferrer',
      header: t('finooAffiliates.portal.leads.initialReferrer', 'Initial referrer'),
      cell: ({ row }) => <ExternalValue value={row.original.initialReferrer} />,
      enableSorting: false,
    },
    {
      accessorKey: 'commissionStatus',
      header: t('finooAffiliates.portal.leads.commissionStatus', 'Commission status'),
      cell: ({ row }) => {
        const status = row.original.commissionStatus
        const styles = status === 'approved'
          ? 'bg-status-success-bg text-status-success-text'
          : status === 'rejected'
            ? 'bg-status-error-bg text-status-error-text'
            : 'bg-status-warning-bg text-status-warning-text'
        return <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${styles}`}>{statusLabel(status)}</span>
      },
    },
    {
      accessorKey: 'commissionAmount',
      header: t('finooAffiliates.portal.leads.commissionAmount', 'Commission amount'),
      cell: ({ row }) => row.original.commissionAmount.toLocaleString(),
    },
  ], [statusLabel, t])

  return (
    <div className="flex flex-col gap-6">
      <PortalPageHeader
        label={t('finooAffiliates.portal.leads.label', 'Affiliate')}
        title={t('finooAffiliates.portal.leads.title', 'Leads')}
      />
      <DataTable
        columns={columns}
        data={items}
        isLoading={loading}
        error={error}
        sortable
        manualSorting
        sorting={sorting}
        onSortingChange={(next) => {
          setSorting(next)
          setPage(1)
        }}
        pagination={{
          page,
          pageSize,
          total,
          totalPages: Math.max(1, Math.ceil(total / pageSize)),
          onPageChange: setPage,
          onPageSizeChange: (nextPageSize) => {
            setPageSize(nextPageSize)
            setPage(1)
          },
        }}
        extensionTableId="finoo_affiliates.portal.leads"
        embedded
      />
    </div>
  )
}
