"use client"

import * as React from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { Page, PageBody, PageHeader } from '@open-mercato/ui/backend/Page'
import { DataTable } from '@open-mercato/ui/backend/DataTable'
import { RowActions } from '@open-mercato/ui/backend/RowActions'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import { useConfirmDialog } from '@open-mercato/ui/backend/confirm-dialog'
import { readApiResultOrThrow, withScopedApiRequestHeaders } from '@open-mercato/ui/backend/utils/apiCall'
import { buildOptimisticLockHeader } from '@open-mercato/ui/backend/utils/optimisticLock'
import { surfaceRecordConflict } from '@open-mercato/ui/backend/conflicts'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { Label } from '@open-mercato/ui/primitives/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@open-mercato/ui/primitives/select'

type Affiliate = { id: string; displayName: string; email: string }
type LinkRow = {
  id: string
  affiliate_user_id: string
  code: string
  label: string
  destination_url: string
  is_active: boolean
  updated_at: string
}

export default function FinooAffiliateLinksPage() {
  const t = useT()
  const [affiliates, setAffiliates] = React.useState<Affiliate[]>([])
  const [links, setLinks] = React.useState<LinkRow[]>([])
  const [page, setPage] = React.useState(1)
  const [pageSize, setPageSize] = React.useState(25)
  const [total, setTotal] = React.useState(0)
  const [affiliateUserId, setAffiliateUserId] = React.useState('')
  const [label, setLabel] = React.useState('')
  const [destinationUrl, setDestinationUrl] = React.useState('')
  const [editingLinkId, setEditingLinkId] = React.useState<string | null>(null)
  const [origin, setOrigin] = React.useState('')
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const { confirm, ConfirmDialogElement } = useConfirmDialog()
  const { runMutation, retryLastMutation } = useGuardedMutation<Record<string, unknown>>({ contextId: 'finoo-affiliate-links' })

  const load = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [usersPayload, linksPayload] = await Promise.all([
        readApiResultOrThrow<{ items: Affiliate[] }>('/api/finoo_affiliates/affiliate-users'),
        readApiResultOrThrow<{ items: LinkRow[]; total: number }>(`/api/finoo_affiliates/links?page=${page}&pageSize=${pageSize}`),
      ])
      setAffiliates(usersPayload.items ?? [])
      setLinks(linksPayload.items ?? [])
      setTotal(linksPayload.total ?? 0)
    } catch {
      setError(t('finooAffiliates.links.loadError', 'Unable to load affiliate links.'))
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, t])

  React.useEffect(() => {
    setOrigin(window.location.origin)
    void load()
  }, [load])

  function resetForm() {
    setEditingLinkId(null)
    setAffiliateUserId('')
    setLabel('')
    setDestinationUrl('')
  }

  async function saveLink(event: React.FormEvent) {
    event.preventDefault()
    const editingLink = editingLinkId ? links.find((link) => link.id === editingLinkId) : null
    const payload = {
      ...(editingLink ? { id: editingLink.id } : {}),
      affiliateUserId,
      label,
      destinationUrl,
      isActive: editingLink?.is_active ?? true,
    }
    setSaving(true)
    setError(null)
    try {
      await runMutation({
        operation: () => withScopedApiRequestHeaders(
          buildOptimisticLockHeader(editingLink?.updated_at ?? null),
          () => readApiResultOrThrow('/api/finoo_affiliates/links', {
            method: editingLink ? 'PUT' : 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          }),
        ),
        mutationPayload: payload,
        context: {
          resourceKind: 'finoo_affiliates.link',
          resourceId: editingLink?.id,
          retryLastMutation,
        },
      })
      flash(
        editingLink
          ? t('finooAffiliates.links.updated', 'Affiliate link updated.')
          : t('finooAffiliates.links.created', 'Affiliate link created.'),
        'success',
      )
      resetForm()
      await load()
    } catch (caught) {
      if (!surfaceRecordConflict(caught, t)) {
        setError(t('finooAffiliates.links.saveError', 'Unable to save affiliate link.'))
      }
    } finally {
      setSaving(false)
    }
  }

  const toggleActive = React.useCallback(async (row: LinkRow) => {
    const payload = { id: row.id, isActive: !row.is_active }
    try {
      await runMutation({
        operation: () => withScopedApiRequestHeaders(
          buildOptimisticLockHeader(row.updated_at),
          () => readApiResultOrThrow('/api/finoo_affiliates/links', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          }),
        ),
        mutationPayload: payload,
        context: { resourceKind: 'finoo_affiliates.link', resourceId: row.id, retryLastMutation },
      })
      await load()
    } catch (caught) {
      if (!surfaceRecordConflict(caught, t)) {
        setError(t('finooAffiliates.links.updateError', 'Unable to update affiliate link.'))
      }
    }
  }, [load, retryLastMutation, runMutation, t])

  const editLink = React.useCallback((row: LinkRow) => {
    setEditingLinkId(row.id)
    setAffiliateUserId(row.affiliate_user_id)
    setLabel(row.label)
    setDestinationUrl(row.destination_url)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }, [])

  const deleteLink = React.useCallback(async (row: LinkRow) => {
    const confirmed = await confirm({
      title: t('finooAffiliates.links.deleteConfirm', 'Delete affiliate link "{{label}}"?').replace('{{label}}', row.label),
      variant: 'destructive',
    })
    if (!confirmed) return
    const payload = { id: row.id }
    try {
      await runMutation({
        operation: () => withScopedApiRequestHeaders(
          buildOptimisticLockHeader(row.updated_at),
          () => readApiResultOrThrow('/api/finoo_affiliates/links', {
            method: 'DELETE',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          }),
        ),
        mutationPayload: payload,
        context: { resourceKind: 'finoo_affiliates.link', resourceId: row.id, retryLastMutation },
      })
      if (editingLinkId === row.id) resetForm()
      flash(t('finooAffiliates.links.deleted', 'Affiliate link deleted.'), 'success')
      await load()
    } catch (caught) {
      if (!surfaceRecordConflict(caught, t)) {
        setError(t('finooAffiliates.links.deleteError', 'Unable to delete affiliate link.'))
      }
    }
  }, [confirm, editingLinkId, load, retryLastMutation, runMutation, t])

  const affiliateNames = React.useMemo(
    () => new Map(affiliates.map((affiliate) => [affiliate.id, affiliate.displayName || affiliate.email])),
    [affiliates],
  )

  const columns = React.useMemo<ColumnDef<LinkRow>[]>(() => [
    { accessorKey: 'label', header: t('finooAffiliates.links.label', 'Label') },
    {
      accessorKey: 'affiliate_user_id',
      header: t('finooAffiliates.links.affiliate', 'Affiliate'),
      cell: ({ row }) => affiliateNames.get(row.original.affiliate_user_id) ?? row.original.affiliate_user_id,
    },
    {
      id: 'trackedUrl',
      header: t('finooAffiliates.links.trackedUrl', 'Tracked URL'),
      cell: ({ row }) => {
        const trackedPath = `/api/finoo_affiliates/r/${row.original.code}`
        const trackedUrl = `${origin}${trackedPath}`
        return (
          <div className="flex max-w-lg items-center gap-2">
            <code className="truncate text-xs">{trackedUrl}</code>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                void navigator.clipboard.writeText(`${window.location.origin}${trackedPath}`)
                flash(t('finooAffiliates.links.copied', 'Link copied.'), 'success')
              }}
            >
              {t('finooAffiliates.links.copy', 'Copy')}
            </Button>
          </div>
        )
      },
      enableSorting: false,
    },
    {
      accessorKey: 'is_active',
      header: t('finooAffiliates.links.status', 'Status'),
      cell: ({ row }) => (
        <Button type="button" variant="outline" size="sm" onClick={() => void toggleActive(row.original)}>
          {row.original.is_active
            ? t('finooAffiliates.links.active', 'Active')
            : t('finooAffiliates.links.inactive', 'Inactive')}
        </Button>
      ),
    },
  ], [affiliateNames, origin, t, toggleActive])

  return (
    <Page>
      <PageHeader title={t('finooAffiliates.links.title', 'Affiliate links')} />
      <PageBody>
        <form className="mb-6 grid gap-4 rounded-lg border border-border p-4 md:grid-cols-2 xl:grid-cols-4" onSubmit={saveLink}>
          <div className="space-y-1.5">
            <Label htmlFor="affiliate-user">{t('finooAffiliates.links.affiliate', 'Affiliate')}</Label>
            <Select value={affiliateUserId} onValueChange={setAffiliateUserId} disabled={saving}>
              <SelectTrigger id="affiliate-user"><SelectValue placeholder={t('finooAffiliates.links.selectAffiliate', 'Select an affiliate')} /></SelectTrigger>
              <SelectContent>
                {affiliates.map((affiliate) => <SelectItem key={affiliate.id} value={affiliate.id}>{affiliate.displayName || affiliate.email}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="affiliate-link-label">{t('finooAffiliates.links.label', 'Label')}</Label>
            <Input id="affiliate-link-label" value={label} onChange={(event) => setLabel(event.target.value)} maxLength={160} required disabled={saving} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="affiliate-destination">{t('finooAffiliates.links.destination', 'Destination URL')}</Label>
            <Input id="affiliate-destination" type="url" value={destinationUrl} onChange={(event) => setDestinationUrl(event.target.value)} required disabled={saving} />
          </div>
          <div className="flex items-end">
            <Button type="submit" disabled={saving || !affiliateUserId || !label || !destinationUrl}>
              {saving
                ? t('finooAffiliates.common.saving', 'Saving…')
                : editingLinkId
                  ? t('finooAffiliates.common.save', 'Save')
                  : t('finooAffiliates.links.create', 'Create link')}
            </Button>
            {editingLinkId ? (
              <Button type="button" variant="ghost" className="ml-2" onClick={resetForm} disabled={saving}>
                {t('finooAffiliates.common.cancel', 'Cancel')}
              </Button>
            ) : null}
          </div>
        </form>
        {error ? <p className="mb-4 text-sm text-destructive">{error}</p> : null}
        <DataTable
          columns={columns}
          data={links}
          isLoading={loading}
          sortable
          perspective={{ tableId: 'finoo_affiliates.links' }}
          entityId="finoo_affiliates:finoo_affiliate_link"
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
          rowActions={(row) => (
            <RowActions
              items={[
                { id: 'edit', label: t('finooAffiliates.links.edit', 'Edit'), onSelect: () => editLink(row) },
                { id: 'delete', label: t('finooAffiliates.links.delete', 'Delete'), destructive: true, onSelect: () => { void deleteLink(row) } },
              ]}
            />
          )}
        />
      </PageBody>
      {ConfirmDialogElement}
    </Page>
  )
}
