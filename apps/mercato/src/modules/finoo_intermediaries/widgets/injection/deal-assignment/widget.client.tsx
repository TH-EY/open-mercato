"use client"

import * as React from 'react'
import type { InjectionWidgetComponentProps } from '@open-mercato/shared/modules/widgets/injection'
import { hasFeature } from '@open-mercato/shared/security/features'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { useBackendChrome } from '@open-mercato/ui/backend/BackendChromeProvider'
import { useConfirmDialog } from '@open-mercato/ui/backend/confirm-dialog'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import { ErrorMessage, LoadingMessage } from '@open-mercato/ui/backend/detail'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { buildOptimisticLockHeader } from '@open-mercato/ui/backend/utils/optimisticLock'
import { Button } from '@open-mercato/ui/primitives/button'
import { FormField } from '@open-mercato/ui/primitives/form-field'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@open-mercato/ui/primitives/select'
import { StatusBadge, type StatusMap } from '@open-mercato/ui/primitives/status-badge'

type WidgetContext = { dealId?: string }
type Assignment = {
  id: string
  dealId: string
  intermediaryCustomerUserId: string
  intermediaryRoleId: string
  eligibleStageId: string
  partnerStatus: 'new' | 'in_progress' | 'done'
  statusUpdatedAt: string | null
  createdAt: string
  updatedAt: string
}
type Intermediary = { id: string; displayName: string; email: string }
type StaffNote = { id: string; authorCustomerUserId: string; body: string; createdAt: string; updatedAt: string }

const statusMap: StatusMap<Assignment['partnerStatus']> = {
  new: 'neutral',
  in_progress: 'info',
  done: 'success',
}

export default function DealAssignmentWidget({ context }: InjectionWidgetComponentProps<WidgetContext>) {
  const t = useT()
  const dealId = context?.dealId ?? null
  const { payload, isReady } = useBackendChrome()
  const canManage = isReady && hasFeature(payload?.grantedFeatures ?? [], 'finoo_intermediaries.manage')
  const { confirm, ConfirmDialogElement } = useConfirmDialog()
  const [assignment, setAssignment] = React.useState<Assignment | null>(null)
  const [intermediaries, setIntermediaries] = React.useState<Intermediary[]>([])
  const [notes, setNotes] = React.useState<StaffNote[]>([])
  const [notesCursor, setNotesCursor] = React.useState<string | null>(null)
  const [selectedUserId, setSelectedUserId] = React.useState('')
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [saving, setSaving] = React.useState(false)
  const { runMutation, retryLastMutation } = useGuardedMutation<{ dealId: string }>({
    contextId: `finoo_intermediaries.staff.${dealId ?? 'missing'}`,
    blockedMessage: t('finoo_intermediaries.staff.blocked', 'Assignment change blocked.'),
  })

  const load = React.useCallback(async () => {
    if (!dealId) return
    setLoading(true)
    setError(null)
    try {
      const [assignmentResult, intermediariesResult] = await Promise.all([
        readApiResultOrThrow<{ assignment: Assignment | null; notes: StaffNote[]; notesNextCursor: string | null }>(`/api/finoo_intermediaries/admin/assignments?dealId=${encodeURIComponent(dealId)}`),
        canManage
          ? readApiResultOrThrow<{ items: Intermediary[] }>('/api/finoo_intermediaries/admin/intermediaries?pageSize=100')
          : Promise.resolve({ items: [] }),
      ])
      setAssignment(assignmentResult.assignment)
      setSelectedUserId(assignmentResult.assignment?.intermediaryCustomerUserId ?? '')
      setIntermediaries(intermediariesResult.items)
      setNotes(assignmentResult.notes)
      setNotesCursor(assignmentResult.notesNextCursor)
    } catch {
      setError(t('finoo_intermediaries.staff.loadError', 'Unable to load intermediary assignment.'))
    } finally {
      setLoading(false)
    }
  }, [canManage, dealId, t])

  React.useEffect(() => { void load() }, [load])

  async function saveAssignment() {
    if (!dealId || !selectedUserId) return
    if (assignment && selectedUserId !== assignment.intermediaryCustomerUserId) {
      const confirmed = await confirm({
        title: t('finoo_intermediaries.staff.reassignConfirm', 'Transfer this deal to the selected intermediary?'),
        variant: 'destructive',
      })
      if (!confirmed) return
    }
    setSaving(true)
    try {
      await runMutation({
        context: { dealId },
        mutationPayload: { intermediaryCustomerUserId: selectedUserId },
        operation: async () => {
          const result = await readApiResultOrThrow<{ assignment: Assignment }>(
            assignment
              ? `/api/finoo_intermediaries/admin/assignments/${assignment.id}`
              : '/api/finoo_intermediaries/admin/assignments',
            {
              method: assignment ? 'PUT' : 'POST',
              headers: {
                'content-type': 'application/json',
                ...(assignment ? buildOptimisticLockHeader(assignment.updatedAt) : {}),
              },
              body: JSON.stringify(assignment
                ? {
                    intermediaryCustomerUserId: selectedUserId,
                    expectedUpdatedAt: assignment.updatedAt,
                  }
                : { dealId, intermediaryCustomerUserId: selectedUserId }),
            },
          )
          setAssignment(result.assignment)
          flash(t('finoo_intermediaries.staff.saved', 'Intermediary assignment saved.'), 'success')
        },
      })
    } finally {
      setSaving(false)
    }
  }

  async function unassign() {
    if (!dealId || !assignment) return
    const confirmed = await confirm({
      title: t('finoo_intermediaries.staff.unassignConfirm', 'Remove this intermediary assignment?'),
      variant: 'destructive',
    })
    if (!confirmed) return
    setSaving(true)
    try {
      await runMutation({
        context: { dealId },
        mutationPayload: { assignmentId: assignment.id },
        operation: async () => {
          await readApiResultOrThrow<{ ok: boolean }>(`/api/finoo_intermediaries/admin/assignments/${assignment.id}`, {
            method: 'DELETE',
            headers: { 'content-type': 'application/json', ...buildOptimisticLockHeader(assignment.updatedAt) },
            body: JSON.stringify({ expectedUpdatedAt: assignment.updatedAt }),
          })
          setAssignment(null)
          setSelectedUserId('')
          setNotes([])
          setNotesCursor(null)
          flash(t('finoo_intermediaries.staff.unassigned', 'Intermediary assignment removed.'), 'success')
        },
      })
    } finally {
      setSaving(false)
    }
  }

  async function loadMoreNotes() {
    if (!assignment || !notesCursor) return
    const result = await readApiResultOrThrow<{ items: StaffNote[]; nextCursor: string | null }>(
      `/api/finoo_intermediaries/admin/assignments/${assignment.id}/notes?pageSize=50&cursor=${encodeURIComponent(notesCursor)}`,
    )
    setNotes((previous) => [...previous, ...result.items])
    setNotesCursor(result.nextCursor)
  }

  if (!dealId) return <ErrorMessage label={t('finoo_intermediaries.staff.missingDeal', 'Deal context is unavailable.')} />
  if (loading) return <LoadingMessage label={t('common.loading', 'Loading…')} />
  if (error) return <ErrorMessage label={error} />

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-medium">{t('finoo_intermediaries.staff.currentStatus', 'Partner status')}</span>
        {assignment ? (
          <StatusBadge variant={statusMap[assignment.partnerStatus]}>
            {t(`finoo_intermediaries.status.${assignment.partnerStatus}`, assignment.partnerStatus)}
          </StatusBadge>
        ) : <span className="text-sm text-muted-foreground">{t('finoo_intermediaries.staff.unassignedState', 'Not assigned')}</span>}
      </div>

      {canManage ? (
        <div className="space-y-3">
          <FormField label={t('finoo_intermediaries.staff.intermediary', 'Intermediary')}>
            <Select value={selectedUserId} onValueChange={setSelectedUserId}>
              <SelectTrigger><SelectValue placeholder={t('finoo_intermediaries.staff.selectIntermediary', 'Select intermediary')} /></SelectTrigger>
              <SelectContent>
                {intermediaries.map((intermediary) => (
                  <SelectItem key={intermediary.id} value={intermediary.id}>
                    {intermediary.displayName} ({intermediary.email})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={saving || !selectedUserId || selectedUserId === assignment?.intermediaryCustomerUserId} onClick={() => void saveAssignment()}>{t('common.save', 'Save')}</Button>
            {assignment ? <Button type="button" variant="destructive-outline" disabled={saving} onClick={() => void unassign()}>{t('finoo_intermediaries.staff.unassign', 'Unassign')}</Button> : null}
            <Button type="button" variant="outline" disabled={saving} onClick={() => void retryLastMutation()}>{t('common.retry', 'Retry')}</Button>
          </div>
        </div>
      ) : null}

      <section className="space-y-3">
        <h3 className="text-sm font-semibold">{t('finoo_intermediaries.staff.notesTitle', 'Partner notes')}</h3>
        {notes.length ? (
          <ul className="divide-y divide-border border-y border-border">
            {notes.map((note) => (
              <li key={note.id} className="space-y-1 py-3">
                <p className="whitespace-pre-wrap text-sm">{note.body}</p>
                <p className="text-xs text-muted-foreground">{note.authorCustomerUserId} — {new Date(note.updatedAt).toLocaleString()}</p>
              </li>
            ))}
          </ul>
        ) : <p className="text-sm text-muted-foreground">{t('finoo_intermediaries.staff.notesEmpty', 'No partner notes.')}</p>}
        {notesCursor ? <Button type="button" variant="outline" onClick={() => void loadMoreNotes()}>{t('common.loadMore', 'Load more')}</Button> : null}
      </section>
      {ConfirmDialogElement}
    </div>
  )
}
