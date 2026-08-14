"use client"

import * as React from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import { useRouter } from 'next/navigation'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { DataTable } from '@open-mercato/ui/backend/DataTable'
import { ErrorMessage, LoadingMessage } from '@open-mercato/ui/backend/detail'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { PortalEmptyState } from '@open-mercato/ui/portal/components/PortalEmptyState'
import { PortalPageHeader } from '@open-mercato/ui/portal/components/PortalPageHeader'
import { Button } from '@open-mercato/ui/primitives/button'
import { StatusBadge, type StatusMap } from '@open-mercato/ui/primitives/status-badge'
import { BriefcaseBusiness } from 'lucide-react'

type PortalDeal = {
  id: string
  companyName: string | null
  companyPhone: string | null
  personMobile: string | null
  personEmail: string | null
  turnover: number | null
  businessStartDate: string | null
  arrears: boolean | null
  industry: string | null
  partnerStatus: 'new' | 'in_progress' | 'done'
}

const statusMap: StatusMap<PortalDeal['partnerStatus']> = {
  new: 'neutral',
  in_progress: 'info',
  done: 'success',
}

export default function DealsPageClient({ orgSlug }: { orgSlug: string }) {
  const t = useT()
  const router = useRouter()
  const [items, setItems] = React.useState<PortalDeal[]>([])
  const [nextCursor, setNextCursor] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    let cancelled = false
    void readApiResultOrThrow<{ items: PortalDeal[]; nextCursor: string | null }>('/api/finoo_intermediaries/portal/deals?pageSize=50')
      .then((result) => {
        if (!cancelled) {
          setItems(result.items)
          setNextCursor(result.nextCursor)
        }
      })
      .catch(() => { if (!cancelled) setError(t('finoo_intermediaries.portal.errors.load', 'Unable to load assigned deals.')) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [t])

  async function loadMore() {
    if (!nextCursor) return
    setLoading(true)
    try {
      const result = await readApiResultOrThrow<{ items: PortalDeal[]; nextCursor: string | null }>(
        `/api/finoo_intermediaries/portal/deals?pageSize=50&cursor=${encodeURIComponent(nextCursor)}`,
      )
      setItems((previous) => [...previous, ...result.items])
      setNextCursor(result.nextCursor)
    } catch {
      setError(t('finoo_intermediaries.portal.errors.load', 'Unable to load assigned deals.'))
    } finally {
      setLoading(false)
    }
  }

  const columns = React.useMemo<ColumnDef<PortalDeal>[]>(() => [
    { accessorKey: 'companyName', header: t('finoo_intermediaries.fields.companyName', 'Company') },
    { accessorKey: 'companyPhone', header: t('finoo_intermediaries.fields.companyPhone', 'Company phone') },
    { accessorKey: 'personMobile', header: t('finoo_intermediaries.fields.personMobile', 'Person mobile') },
    { accessorKey: 'personEmail', header: t('finoo_intermediaries.fields.personEmail', 'Person email') },
    { accessorKey: 'turnover', header: t('finoo_intermediaries.fields.turnover', 'Turnover') },
    { accessorKey: 'businessStartDate', header: t('finoo_intermediaries.fields.businessStartDate', 'Business start date') },
    {
      accessorKey: 'arrears',
      header: t('finoo_intermediaries.fields.arrears', 'Arrears'),
      cell: ({ row }) => row.original.arrears == null
        ? '—'
        : row.original.arrears
          ? t('common.yes', 'Yes')
          : t('common.no', 'No'),
    },
    { accessorKey: 'industry', header: t('finoo_intermediaries.fields.industry', 'Industry') },
    {
      accessorKey: 'partnerStatus',
      header: t('finoo_intermediaries.fields.partnerStatus', 'Partner status'),
      cell: ({ row }) => (
        <StatusBadge variant={statusMap[row.original.partnerStatus]}>
          {t(`finoo_intermediaries.status.${row.original.partnerStatus}`, row.original.partnerStatus)}
        </StatusBadge>
      ),
    },
  ], [t])

  if (loading) return <LoadingMessage label={t('common.loading', 'Loading…')} />
  if (error) return <ErrorMessage label={error} />

  return (
    <div className="space-y-6">
      <PortalPageHeader
        label={t('finoo_intermediaries.portal.deals.label', 'Intermediary')}
        title={t('finoo_intermediaries.portal.deals.title', 'Assigned deals')}
      />
      {items.length ? (
        <div className="space-y-4">
          <DataTable<PortalDeal>
            columns={columns}
            data={items}
            entityId="finoo_intermediaries:portal_deal"
            extensionTableId="finoo_intermediaries.portal.deals"
            onRowClick={(row) => router.push(`/${orgSlug}/portal/intermediary/deals/${row.id}`)}
          />
          {nextCursor ? (
            <Button type="button" variant="outline" disabled={loading} onClick={() => void loadMore()}>
              {t('common.loadMore', 'Load more')}
            </Button>
          ) : null}
        </div>
      ) : (
        <PortalEmptyState
          icon={<BriefcaseBusiness className="size-5" aria-hidden />}
          title={t('finoo_intermediaries.portal.deals.emptyTitle', 'No assigned deals')}
          description={t('finoo_intermediaries.portal.deals.emptyDescription', 'Eligible deals assigned to you will appear here.')}
        />
      )}
    </div>
  )
}
