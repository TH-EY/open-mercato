"use client"

import * as React from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import { Plus, Users } from 'lucide-react'
import { hasAllFeatures, hasFeature } from '@open-mercato/shared/security/features'
import { useOrganizationScopeVersion } from '@open-mercato/shared/lib/frontend/useOrganizationScope'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { useBackendChrome } from '@open-mercato/ui/backend/BackendChromeProvider'
import { DataTable } from '@open-mercato/ui/backend/DataTable'
import type { FilterDef, FilterValues } from '@open-mercato/ui/backend/FilterBar'
import { RowActions } from '@open-mercato/ui/backend/RowActions'
import { ErrorMessage, LoadingMessage } from '@open-mercato/ui/backend/detail'
import { ListEmptyState } from '@open-mercato/ui/backend/filters/ListEmptyState'
import { PageBody, PageHeader } from '@open-mercato/ui/backend/Page'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { Button } from '@open-mercato/ui/primitives/button'
import { StatusBadge, type StatusMap } from '@open-mercato/ui/primitives/status-badge'
import { IntermediaryDialog } from './intermediary-dialog.client'
import { useIntermediaryRowActions } from './intermediary-row-actions.client'
import type { DirectoryResponse, IntermediaryDirectoryItem, IntermediaryStatus } from './types'

const statusMap: StatusMap<IntermediaryStatus> = {
  active: 'success',
  invited: 'info',
  expired: 'warning',
  delivery_failed: 'error',
  inactive: 'neutral',
}

export default function IntermediariesClient() {
  const t = useT()
  const { payload, isReady } = useBackendChrome()
  const scopeVersion = useOrganizationScopeVersion()
  const grantedFeatures = payload?.grantedFeatures ?? []
  const canManage = isReady && hasFeature(grantedFeatures, 'finoo_intermediaries.manage')
  const canManageAccounts = isReady && hasFeature(grantedFeatures, 'customer_accounts.manage')
  const canInvite = isReady && hasAllFeatures(grantedFeatures, [
    'finoo_intermediaries.manage',
    'customer_accounts.invite',
    'customer_accounts.manage',
  ])
  const [rows, setRows] = React.useState<IntermediaryDirectoryItem[]>([])
  const [nextCursor, setNextCursor] = React.useState<string | null>(null)
  const [search, setSearch] = React.useState('')
  const [filterValues, setFilterValues] = React.useState<FilterValues>({})
  const [loading, setLoading] = React.useState(true)
  const [loadingMore, setLoadingMore] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [reloadToken, setReloadToken] = React.useState(0)
  const [inviteOpen, setInviteOpen] = React.useState(false)
  const [editingRow, setEditingRow] = React.useState<IntermediaryDirectoryItem | null>(null)
  const requestSequence = React.useRef(0)
  const status = typeof filterValues.status === 'string' ? filterValues.status : ''

  const loadPage = React.useCallback(async (cursor: string | null, append: boolean) => {
    const sequence = ++requestSequence.current
    if (append) setLoadingMore(true)
    else setLoading(true)
    setError(null)
    const params = new URLSearchParams({ pageSize: '50' })
    const normalizedSearch = search.trim()
    if (normalizedSearch) params.set('search', normalizedSearch)
    if (status) params.set('status', status)
    if (cursor) params.set('cursor', cursor)
    try {
      const call = await apiCall<DirectoryResponse>(
        `/api/finoo_intermediaries/admin/directory?${params.toString()}`,
      )
      if (!call.ok || !call.result) throw new Error('[internal] Directory load failed')
      if (sequence !== requestSequence.current) return
      setRows((current) => append ? [...current, ...call.result!.items] : call.result!.items)
      setNextCursor(call.result.nextCursor)
    } catch {
      if (sequence === requestSequence.current) {
        setError(t('finoo_intermediaries.directory.errors.load'))
      }
    } finally {
      if (sequence === requestSequence.current) {
        setLoading(false)
        setLoadingMore(false)
      }
    }
  }, [search, status, t])

  React.useEffect(() => {
    setRows([])
    setNextCursor(null)
    void loadPage(null, false)
    return () => { requestSequence.current += 1 }
  }, [loadPage, reloadToken, scopeVersion])

  const upsertRow = React.useCallback((item: IntermediaryDirectoryItem) => {
    setRows((current) => {
      const index = current.findIndex((row) => row.id === item.id)
      if (index === -1) return [item, ...current]
      return current.map((row) => row.id === item.id ? item : row)
    })
  }, [])
  const reload = React.useCallback(() => setReloadToken((token) => token + 1), [])
  const { getRowActions, ConfirmDialogElement } = useIntermediaryRowActions({
    canManage,
    canInvite,
    canManageAccounts,
    onEdit: setEditingRow,
    onSaved: upsertRow,
    onReload: reload,
  })
  const columns = React.useMemo<ColumnDef<IntermediaryDirectoryItem>[]>(() => [
    {
      accessorKey: 'firstName',
      header: t('finoo_intermediaries.directory.columns.firstName'),
      meta: { truncate: true, maxWidth: 220 },
    },
    {
      accessorKey: 'lastName',
      header: t('finoo_intermediaries.directory.columns.lastName'),
      meta: { truncate: true, maxWidth: 220 },
    },
    {
      accessorKey: 'email',
      header: t('finoo_intermediaries.directory.columns.email'),
      meta: { truncate: true, maxWidth: 320 },
    },
    {
      accessorKey: 'status',
      header: t('finoo_intermediaries.directory.columns.status'),
      cell: ({ row }) => (
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge variant={statusMap[row.original.status]} dot>
            {t(`finoo_intermediaries.directory.status.${row.original.status}`)}
          </StatusBadge>
          {row.original.status === 'active' && row.original.lastEmailStatus === 'failed' ? (
            <StatusBadge variant="warning">
              {t('finoo_intermediaries.directory.status.emailWarning')}
            </StatusBadge>
          ) : null}
        </div>
      ),
    },
    {
      accessorKey: 'relatedDeals',
      header: t('finoo_intermediaries.directory.columns.relatedDeals'),
    },
  ], [t])
  const filters = React.useMemo<FilterDef[]>(() => [{
    id: 'status',
    label: t('finoo_intermediaries.directory.filters.status'),
    type: 'select',
    options: (Object.keys(statusMap) as IntermediaryStatus[]).map((value) => ({
      value,
      label: t(`finoo_intermediaries.directory.status.${value}`),
    })),
  }], [t])
  const emptyState = React.useMemo(() => (
    <ListEmptyState
      icon={<Users className="size-7" aria-hidden />}
      title={t('finoo_intermediaries.directory.empty.title')}
      description={t('finoo_intermediaries.directory.empty.description')}
      onCreate={canInvite ? () => setInviteOpen(true) : undefined}
      createLabel={t('finoo_intermediaries.directory.actions.invite')}
    />
  ), [canInvite, t])

  return (
    <>
      <PageHeader
        title={t('finoo_intermediaries.directory.title')}
        description={t('finoo_intermediaries.directory.description')}
        actions={canInvite ? (
          <Button type="button" onClick={() => setInviteOpen(true)}>
            <Plus className="size-4" aria-hidden />
            {t('finoo_intermediaries.directory.actions.invite')}
          </Button>
        ) : undefined}
      />
      <PageBody>
        {loading && rows.length === 0 ? (
          <LoadingMessage label={t('finoo_intermediaries.directory.loading')} />
        ) : error && rows.length === 0 ? (
          <ErrorMessage
            label={error}
            action={<Button type="button" variant="outline" size="sm" onClick={reload}>{t('finoo_intermediaries.directory.actions.retryLoad')}</Button>}
          />
        ) : (
          <>
            <DataTable<IntermediaryDirectoryItem>
              entityId="finoo_intermediaries:finoo_intermediary"
              extensionTableId="finoo_intermediaries.intermediaries"
              columns={columns}
              data={rows}
              isLoading={loading}
              error={error ? <ErrorMessage label={error} /> : null}
              emptyState={emptyState}
              searchValue={search}
              onSearchChange={setSearch}
              searchPlaceholder={t('finoo_intermediaries.directory.search.placeholder')}
              filters={filters}
              filterValues={filterValues}
              onFiltersApply={setFilterValues}
              onFiltersClear={() => setFilterValues({})}
              rowActions={(row) => <RowActions items={getRowActions(row)} />}
              disableRowClick
              stickyActionsColumn
            />
            {nextCursor ? (
              <div className="flex justify-center">
                <Button
                  type="button"
                  variant="outline"
                  disabled={loadingMore}
                  onClick={() => { void loadPage(nextCursor, true) }}
                >
                  {t(loadingMore
                    ? 'finoo_intermediaries.directory.loadingMore'
                    : 'finoo_intermediaries.directory.actions.loadMore')}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </PageBody>
      <IntermediaryDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        mode="invite"
        canInvite={canInvite}
        onSaved={upsertRow}
        onReload={reload}
      />
      <IntermediaryDialog
        open={Boolean(editingRow)}
        onOpenChange={(open) => { if (!open) setEditingRow(null) }}
        mode="edit"
        row={editingRow}
        canInvite={canInvite}
        onSaved={upsertRow}
        onReload={reload}
      />
      {ConfirmDialogElement}
    </>
  )
}
