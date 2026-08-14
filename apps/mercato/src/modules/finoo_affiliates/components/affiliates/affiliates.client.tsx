"use client"

import * as React from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { useOrganizationScopeVersion } from '@open-mercato/shared/lib/frontend/useOrganizationScope'
import { Page, PageBody, PageHeader } from '@open-mercato/ui/backend/Page'
import { DataTable } from '@open-mercato/ui/backend/DataTable'
import { ListEmptyState } from '@open-mercato/ui/backend/filters/ListEmptyState'
import { apiCall, readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { Button } from '@open-mercato/ui/primitives/button'
import InviteAffiliateDialog from './invite-affiliate-dialog.client'

type AffiliateRow = {
  id: string
  email: string
  firstName: string
  lastName: string
  code: string
  trackedUrl: string
  relatedDeals: number
  state: 'invited' | 'active'
  updatedAt: string
}

type AffiliatesResponse = {
  items: AffiliateRow[]
  total: number
  page: number
  pageSize: number
}

type InviteOptions = {
  ok: true
  affiliateRoleId: string
  defaultDestinationReady: boolean
}

const PAGE_SIZE = 25

export default function AffiliatesClient() {
  const t = useT()
  const scopeVersion = useOrganizationScopeVersion()
  const [rows, setRows] = React.useState<AffiliateRow[]>([])
  const [page, setPage] = React.useState(1)
  const [pageSize, setPageSize] = React.useState(PAGE_SIZE)
  const [total, setTotal] = React.useState(0)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [inviteOpen, setInviteOpen] = React.useState(false)
  const [inviteOptions, setInviteOptions] = React.useState<InviteOptions | null>(null)
  const [canInvite, setCanInvite] = React.useState(false)
  const [reloadToken, setReloadToken] = React.useState(0)

  React.useEffect(() => {
    let cancelled = false

    async function loadAccess() {
      try {
        const access = await apiCall<{ ok?: boolean; granted?: string[] }>('/api/auth/feature-check', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ features: ['finoo_affiliates.manage', 'customer_accounts.invite'] }),
        })
        const granted = Array.isArray(access.result?.granted) ? access.result.granted : []
        const permitted = access.ok
          && granted.includes('finoo_affiliates.manage')
          && granted.includes('customer_accounts.invite')
        if (cancelled) return
        setCanInvite(permitted)
        if (!permitted) {
          setInviteOptions(null)
          return
        }
        const options = await readApiResultOrThrow<InviteOptions>('/api/finoo_affiliates/invite-options')
        if (!cancelled) setInviteOptions(options)
      } catch {
        if (!cancelled) {
          setCanInvite(false)
          setInviteOptions(null)
        }
      }
    }

    void loadAccess()
    return () => { cancelled = true }
  }, [scopeVersion])

  React.useEffect(() => {
    let cancelled = false

    async function loadAffiliates() {
      setLoading(true)
      setError(null)
      try {
        const params = new URLSearchParams({
          page: String(page),
          pageSize: String(pageSize),
        })
        const payload = await readApiResultOrThrow<AffiliatesResponse>(`/api/finoo_affiliates/affiliates?${params.toString()}`)
        if (!cancelled) {
          setRows(payload.items)
          setTotal(payload.total)
        }
      } catch {
        if (!cancelled) setError(t('finooAffiliates.affiliates.loadError', 'Unable to load affiliates.'))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void loadAffiliates()
    return () => { cancelled = true }
  }, [page, pageSize, reloadToken, scopeVersion, t])

  const copyTrackedUrl = React.useCallback(async (trackedUrl: string) => {
    try {
      await navigator.clipboard.writeText(trackedUrl)
      flash(t('finooAffiliates.affiliates.linkCopied', 'Affiliate link copied.'), 'success')
    } catch {
      flash(t('finooAffiliates.affiliates.copyError', 'Unable to copy the affiliate link.'), 'error')
    }
  }, [t])

  const columns = React.useMemo<ColumnDef<AffiliateRow>[]>(() => [
    { accessorKey: 'email', header: t('finooAffiliates.affiliates.email', 'Email') },
    { accessorKey: 'firstName', header: t('finooAffiliates.affiliates.firstName', 'First name') },
    { accessorKey: 'lastName', header: t('finooAffiliates.affiliates.lastName', 'Last name') },
    {
      accessorKey: 'code',
      header: t('finooAffiliates.affiliates.code', 'Code'),
      cell: ({ row }) => (
        <div className="flex items-center gap-2">
          <code className="text-xs">{row.original.code}</code>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!row.original.trackedUrl}
            onClick={() => { void copyTrackedUrl(row.original.trackedUrl) }}
          >
            {t('finooAffiliates.affiliates.copyLink', 'Copy link')}
          </Button>
        </div>
      ),
      enableSorting: false,
    },
    { accessorKey: 'relatedDeals', header: t('finooAffiliates.affiliates.relatedDeals', 'Related deals') },
    {
      accessorKey: 'state',
      header: t('finooAffiliates.affiliates.state', 'State'),
      cell: ({ row }) => row.original.state === 'active'
        ? t('finooAffiliates.affiliates.active', 'Active')
        : t('finooAffiliates.affiliates.invited', 'Invited'),
    },
  ], [copyTrackedUrl, t])

  const inviteAction = canInvite && inviteOptions ? (
    <Button type="button" onClick={() => setInviteOpen(true)}>
      {t('finooAffiliates.affiliates.invite', 'Invite affiliate')}
    </Button>
  ) : null

  return (
    <Page>
      <PageHeader title={t('finooAffiliates.affiliates.title', 'Affiliates')} />
      <PageBody>
        <DataTable<AffiliateRow>
          title={t('finooAffiliates.affiliates.title', 'Affiliates')}
          actions={inviteAction}
          columns={columns}
          data={rows}
          isLoading={loading}
          error={error}
          perspective={{ tableId: 'finoo_affiliates.affiliates' }}
          entityId="finoo_affiliates:finoo_affiliate"
          emptyState={(
            <ListEmptyState
              entityName={t('finooAffiliates.affiliates.title', 'Affiliates')}
              title={t('finooAffiliates.affiliates.emptyTitle', 'No affiliates yet')}
              onCreate={inviteAction ? () => setInviteOpen(true) : undefined}
              createLabel={inviteAction ? t('finooAffiliates.affiliates.invite', 'Invite affiliate') : undefined}
            />
          )}
          pagination={{
            page,
            pageSize,
            total,
            totalPages: Math.max(1, Math.ceil(total / pageSize)),
            onPageChange: setPage,
            pageSizeOptions: [10, 25, 50, 100],
            onPageSizeChange: (nextPageSize) => {
              setPageSize(nextPageSize)
              setPage(1)
            },
          }}
        />
      </PageBody>
      {inviteOptions ? (
        <InviteAffiliateDialog
          open={inviteOpen}
          onOpenChange={setInviteOpen}
          affiliateRoleId={inviteOptions.affiliateRoleId}
          defaultDestinationReady={inviteOptions.defaultDestinationReady}
          onSynchronized={() => setReloadToken((token) => token + 1)}
        />
      ) : null}
    </Page>
  )
}
