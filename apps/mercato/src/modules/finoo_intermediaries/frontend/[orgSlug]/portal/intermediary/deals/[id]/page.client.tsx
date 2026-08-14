"use client"

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Pencil, Trash2 } from 'lucide-react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { useConfirmDialog } from '@open-mercato/ui/backend/confirm-dialog'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import { ErrorMessage, LoadingMessage } from '@open-mercato/ui/backend/detail'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { buildOptimisticLockHeader } from '@open-mercato/ui/backend/utils/optimisticLock'
import { PortalPageHeader } from '@open-mercato/ui/portal/components/PortalPageHeader'
import { Alert, AlertDescription } from '@open-mercato/ui/primitives/alert'
import { Button } from '@open-mercato/ui/primitives/button'
import { FormField } from '@open-mercato/ui/primitives/form-field'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import { StatusBadge, type StatusMap } from '@open-mercato/ui/primitives/status-badge'
import { Textarea } from '@open-mercato/ui/primitives/textarea'

type Deal = {
  id: string
  assignmentId: string
  updatedAt: string
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

type Note = { id: string; body: string; createdAt: string; updatedAt: string }
type Activity = { id: string; type: string; occurredAt: string | null; direction: null; summary: string }

const statusMap: StatusMap<Deal['partnerStatus']> = {
  new: 'neutral',
  in_progress: 'info',
  done: 'success',
}

function nextStatus(status: Deal['partnerStatus']): Deal['partnerStatus'] | null {
  if (status === 'new') return 'in_progress'
  if (status === 'in_progress') return 'done'
  return null
}

export default function DealDetailPageClient({ orgSlug, dealId }: { orgSlug: string; dealId: string }) {
  const t = useT()
  const router = useRouter()
  const { confirm, ConfirmDialogElement } = useConfirmDialog()
  const [deal, setDeal] = React.useState<Deal | null>(null)
  const [notes, setNotes] = React.useState<Note[]>([])
  const [activities, setActivities] = React.useState<Activity[]>([])
  const [notesCursor, setNotesCursor] = React.useState<string | null>(null)
  const [activitiesCursor, setActivitiesCursor] = React.useState<string | null>(null)
  const [draft, setDraft] = React.useState('')
  const [editingNoteId, setEditingNoteId] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [saving, setSaving] = React.useState(false)
  const { runMutation, retryLastMutation } = useGuardedMutation<{ dealId: string }>({
    contextId: `finoo_intermediaries.portal.${dealId}`,
    blockedMessage: t('finoo_intermediaries.portal.errors.blocked', 'Operation blocked by validation.'),
  })

  const load = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [dealResult, notesResult, activitiesResult] = await Promise.all([
        readApiResultOrThrow<{ deal: Deal }>(`/api/finoo_intermediaries/portal/deals/${dealId}`),
        readApiResultOrThrow<{ items: Note[]; nextCursor: string | null }>(`/api/finoo_intermediaries/portal/deals/${dealId}/notes?pageSize=50`),
        readApiResultOrThrow<{ items: Activity[]; nextCursor: string | null }>(`/api/finoo_intermediaries/portal/deals/${dealId}/activities?pageSize=50`),
      ])
      setDeal(dealResult.deal)
      setNotes(notesResult.items)
      setActivities(activitiesResult.items)
      setNotesCursor(notesResult.nextCursor)
      setActivitiesCursor(activitiesResult.nextCursor)
    } catch {
      setError(t('finoo_intermediaries.portal.errors.loadDetail', 'Unable to load deal details.'))
    } finally {
      setLoading(false)
    }
  }, [dealId, t])

  React.useEffect(() => { void load() }, [load])

  const mutate = React.useCallback(async (operation: () => Promise<void>, payload: Record<string, unknown>) => {
    setSaving(true)
    try {
      await runMutation({
        context: { dealId },
        mutationPayload: payload,
        operation,
      })
    } finally {
      setSaving(false)
    }
  }, [dealId, runMutation])

  async function advanceStatus() {
    if (!deal) return
    const target = nextStatus(deal.partnerStatus)
    if (!target) return
    await mutate(async () => {
      const result = await readApiResultOrThrow<{ status: Deal['partnerStatus']; updatedAt: string }>(
        `/api/finoo_intermediaries/portal/deals/${dealId}/status`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json', ...buildOptimisticLockHeader(deal.updatedAt) },
          body: JSON.stringify({ status: target, expectedUpdatedAt: deal.updatedAt }),
        },
      )
      setDeal({ ...deal, partnerStatus: result.status, updatedAt: result.updatedAt })
      flash(t('finoo_intermediaries.portal.status.updated', 'Partner status updated.'), 'success')
    }, { partnerStatus: target })
  }

  async function submitNote() {
    const body = draft.trim()
    if (!body) return
    const current = editingNoteId ? notes.find((note) => note.id === editingNoteId) : null
    await mutate(async () => {
      const result = await readApiResultOrThrow<{ note: Note }>(
        current
          ? `/api/finoo_intermediaries/portal/deals/${dealId}/notes/${current.id}`
          : `/api/finoo_intermediaries/portal/deals/${dealId}/notes`,
        {
          method: current ? 'PUT' : 'POST',
          headers: {
            'content-type': 'application/json',
            ...(current ? buildOptimisticLockHeader(current.updatedAt) : {}),
          },
          body: JSON.stringify(current
            ? { body, expectedUpdatedAt: current.updatedAt }
            : { body }),
        },
      )
      setNotes((previous) => current
        ? previous.map((note) => note.id === current.id ? result.note : note)
        : [result.note, ...previous])
      setDraft('')
      setEditingNoteId(null)
      flash(t('finoo_intermediaries.portal.notes.saved', 'Note saved.'), 'success')
    }, { noteId: current?.id ?? null, body })
  }

  async function deleteNote(note: Note) {
    const confirmed = await confirm({
      title: t('finoo_intermediaries.portal.notes.deleteConfirm', 'Delete this note?'),
      variant: 'destructive',
    })
    if (!confirmed) return
    await mutate(async () => {
      await readApiResultOrThrow<{ ok: boolean }>(
        `/api/finoo_intermediaries/portal/deals/${dealId}/notes/${note.id}`,
        {
          method: 'DELETE',
          headers: { 'content-type': 'application/json', ...buildOptimisticLockHeader(note.updatedAt) },
          body: JSON.stringify({ expectedUpdatedAt: note.updatedAt }),
        },
      )
      setNotes((previous) => previous.filter((item) => item.id !== note.id))
    }, { noteId: note.id })
  }

  async function loadMoreNotes() {
    if (!notesCursor) return
    const result = await readApiResultOrThrow<{ items: Note[]; nextCursor: string | null }>(
      `/api/finoo_intermediaries/portal/deals/${dealId}/notes?pageSize=50&cursor=${encodeURIComponent(notesCursor)}`,
    )
    setNotes((previous) => [...previous, ...result.items])
    setNotesCursor(result.nextCursor)
  }

  async function loadMoreActivities() {
    if (!activitiesCursor) return
    const result = await readApiResultOrThrow<{ items: Activity[]; nextCursor: string | null }>(
      `/api/finoo_intermediaries/portal/deals/${dealId}/activities?pageSize=50&cursor=${encodeURIComponent(activitiesCursor)}`,
    )
    setActivities((previous) => [...previous, ...result.items])
    setActivitiesCursor(result.nextCursor)
  }

  if (loading) return <LoadingMessage label={t('common.loading', 'Loading…')} />
  if (error || !deal) return <ErrorMessage label={error ?? t('common.notFound', 'Not found')} />

  const targetStatus = nextStatus(deal.partnerStatus)
  const fields = [
    [t('finoo_intermediaries.fields.companyName', 'Company'), deal.companyName],
    [t('finoo_intermediaries.fields.companyPhone', 'Company phone'), deal.companyPhone],
    [t('finoo_intermediaries.fields.personMobile', 'Person mobile'), deal.personMobile],
    [t('finoo_intermediaries.fields.personEmail', 'Person email'), deal.personEmail],
    [t('finoo_intermediaries.fields.turnover', 'Turnover'), deal.turnover],
    [t('finoo_intermediaries.fields.businessStartDate', 'Business start date'), deal.businessStartDate],
    [t('finoo_intermediaries.fields.arrears', 'Arrears'), deal.arrears == null ? null : deal.arrears ? t('common.yes', 'Yes') : t('common.no', 'No')],
    [t('finoo_intermediaries.fields.industry', 'Industry'), deal.industry],
  ] as const

  return (
    <div className="space-y-8">
      <PortalPageHeader
        label={t('finoo_intermediaries.portal.deal.label', 'Assigned deal')}
        title={deal.companyName ?? t('finoo_intermediaries.portal.deal.untitled', 'Deal details')}
        action={<Button type="button" variant="outline" onClick={() => router.push(`/${orgSlug}/portal/intermediary/deals`)}>{t('common.back', 'Back')}</Button>}
      />

      <section className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <StatusBadge variant={statusMap[deal.partnerStatus]}>
            {t(`finoo_intermediaries.status.${deal.partnerStatus}`, deal.partnerStatus)}
          </StatusBadge>
          {targetStatus ? (
            <Button type="button" disabled={saving} onClick={() => void advanceStatus()}>
              {t(`finoo_intermediaries.status.advance.${targetStatus}`, 'Advance status')}
            </Button>
          ) : null}
        </div>
        <dl className="grid gap-4 border-y border-border py-4 md:grid-cols-2">
          {fields.map(([label, value]) => (
            <div key={label} className="space-y-1">
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="text-sm text-foreground">{value == null || value === '' ? '—' : String(value)}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold">{t('finoo_intermediaries.portal.notes.title', 'Private notes')}</h2>
        <FormField label={editingNoteId ? t('finoo_intermediaries.portal.notes.edit', 'Edit note') : t('finoo_intermediaries.portal.notes.add', 'Add note')}>
          <Textarea
            value={draft}
            maxLength={10_000}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void submitNote()
              if (event.key === 'Escape') { setDraft(''); setEditingNoteId(null) }
            }}
          />
        </FormField>
        <div className="flex gap-2">
          <Button type="button" disabled={saving || !draft.trim()} onClick={() => void submitNote()}>{t('common.save', 'Save')}</Button>
          {editingNoteId ? <Button type="button" variant="outline" onClick={() => { setDraft(''); setEditingNoteId(null) }}>{t('common.cancel', 'Cancel')}</Button> : null}
        </div>
        {notes.length ? (
          <ul className="divide-y divide-border border-y border-border">
            {notes.map((note) => (
              <li key={note.id} className="flex gap-4 py-4">
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="whitespace-pre-wrap text-sm text-foreground">{note.body}</p>
                  <p className="text-xs text-muted-foreground">{new Date(note.updatedAt).toLocaleString()}</p>
                </div>
                <div className="flex items-start gap-1">
                  <IconButton type="button" variant="ghost" aria-label={t('common.edit', 'Edit')} onClick={() => { setEditingNoteId(note.id); setDraft(note.body) }}><Pencil className="size-4" /></IconButton>
                  <IconButton type="button" variant="ghost" aria-label={t('common.delete', 'Delete')} onClick={() => void deleteNote(note)}><Trash2 className="size-4" /></IconButton>
                </div>
              </li>
            ))}
          </ul>
        ) : <p className="text-sm text-muted-foreground">{t('finoo_intermediaries.portal.notes.empty', 'No notes yet.')}</p>}
        {notesCursor ? (
          <Button type="button" variant="outline" disabled={saving} onClick={() => void loadMoreNotes()}>
            {t('common.loadMore', 'Load more')}
          </Button>
        ) : null}
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold">{t('finoo_intermediaries.portal.activities.title', 'Activities')}</h2>
        {activities.length ? (
          <ul className="divide-y divide-border border-y border-border">
            {activities.map((activity) => (
              <li key={activity.id} className="space-y-1 py-4">
                <p className="text-sm font-medium">{activity.type}</p>
                <p className="text-sm text-foreground">{activity.summary || '—'}</p>
                {activity.occurredAt ? <p className="text-xs text-muted-foreground">{new Date(activity.occurredAt).toLocaleString()}</p> : null}
              </li>
            ))}
          </ul>
        ) : <p className="text-sm text-muted-foreground">{t('finoo_intermediaries.portal.activities.empty', 'No shared activities.')}</p>}
        {activitiesCursor ? (
          <Button type="button" variant="outline" disabled={saving} onClick={() => void loadMoreActivities()}>
            {t('common.loadMore', 'Load more')}
          </Button>
        ) : null}
      </section>

      <Alert status="information" style="lighter" size="sm">
        <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
          <span>{t('finoo_intermediaries.portal.retryAvailable', 'A blocked operation can be retried after resolving the conflict.')}</span>
          <Button type="button" variant="outline" size="sm" onClick={() => void retryLastMutation()}>{t('common.retry', 'Retry')}</Button>
        </AlertDescription>
      </Alert>
      {ConfirmDialogElement}
    </div>
  )
}
