"use client"

import * as React from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { surfaceRecordConflict } from '@open-mercato/ui/backend/conflicts'
import { ErrorMessage, LoadingMessage } from '@open-mercato/ui/backend/detail'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useConfirmDialog } from '@open-mercato/ui/backend/confirm-dialog'
import { useAppEvent } from '@open-mercato/ui/backend/injection/useAppEvent'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import { useProgressPoll } from '@open-mercato/ui/backend/progress/useProgressPoll'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { Alert } from '@open-mercato/ui/primitives/alert'
import { Button } from '@open-mercato/ui/primitives/button'
import { FormField } from '@open-mercato/ui/primitives/form-field'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@open-mercato/ui/primitives/select'
import { StatusBadge, type StatusMap } from '@open-mercato/ui/primitives/status-badge'

type AvailableDeal = {
  id: string
  state: 'available'
  name: string
  updatedAt: string
  blockedReason: 'ineligible_stage' | null
  assignment: {
    id: string
    intermediaryCustomerUserId: string
    intermediaryDisplayName: string | null
    updatedAt: string
  } | null
}
type BlockedDeal = { id: string; state: 'blocked'; name: null; updatedAt: null; blockedReason: 'not_found'; assignment: null }
type Preflight = {
  deals: Array<AvailableDeal | BlockedDeal>
  intermediaries: Array<{ id: string; displayName: string; email: string }>
}
type DealOutcome = 'create' | 'reassign' | 'unchanged' | 'blocked'
type ProgressJob = {
  id: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  errorMessage?: string | null
}

const outcomeMap: StatusMap<DealOutcome> = {
  create: 'info',
  reassign: 'warning',
  unchanged: 'neutral',
  blocked: 'error',
}

export default function BulkAssignmentClient() {
  const t = useT()
  const router = useRouter()
  const searchParams = useSearchParams()
  const dealIds = searchParams.get('dealIds') ?? ''
  const { confirm, ConfirmDialogElement } = useConfirmDialog()
  const [preflight, setPreflight] = React.useState<Preflight | null>(null)
  const [targetId, setTargetId] = React.useState('')
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [progressJobId, setProgressJobId] = React.useState<string | null>(null)
  const progressJobIdRef = React.useRef<string | null>(null)
  const progress = useProgressPoll()
  const { runMutation, retryLastMutation } = useGuardedMutation({
    contextId: 'finoo_intermediaries.bulk-assignment',
    blockedMessage: t('finoo_intermediaries.bulk.errors.blocked', 'Bulk assignment was blocked.'),
  })

  const load = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await readApiResultOrThrow<Preflight>(
        `/api/finoo_intermediaries/admin/bulk-assignments?dealIds=${encodeURIComponent(dealIds)}`,
      )
      setPreflight(result)
    } catch {
      setError(t('finoo_intermediaries.bulk.errors.load', 'Unable to load the selected Deals.'))
    } finally {
      setLoading(false)
    }
  }, [dealIds, t])

  React.useEffect(() => { void load() }, [load])

  const handleTerminalProgress = React.useCallback((job: ProgressJob) => {
    if (job.id !== progressJobIdRef.current) return
    progressJobIdRef.current = null
    setProgressJobId(null)
    if (job.status === 'completed') {
      window.location.assign('/backend/customers/deals')
      return
    }
    setSaving(false)
    const message = job.errorMessage
      ?? t('finoo_intermediaries.bulk.errors.worker', 'Bulk intermediary assignment failed. Review the selected Deals and try again.')
    setError(message)
    flash(message, 'error')
  }, [t])

  useAppEvent('progress.job.completed', (event) => {
    const payload = event.payload as { jobId?: unknown }
    if (typeof payload.jobId === 'string') handleTerminalProgress({ id: payload.jobId, status: 'completed' })
  }, [handleTerminalProgress])

  useAppEvent('progress.job.failed', (event) => {
    const payload = event.payload as { jobId?: unknown; errorMessage?: unknown }
    if (typeof payload.jobId === 'string') {
      handleTerminalProgress({
        id: payload.jobId,
        status: 'failed',
        errorMessage: typeof payload.errorMessage === 'string' ? payload.errorMessage : null,
      })
    }
  }, [handleTerminalProgress])

  React.useEffect(() => {
    if (!progressJobId) return
    const job = progress.recentlyCompleted.find((candidate) => candidate.id === progressJobId)
    if (job) handleTerminalProgress(job)
  }, [handleTerminalProgress, progress.recentlyCompleted, progressJobId])

  const classified = React.useMemo(() => (preflight?.deals ?? []).map((deal) => {
    let outcome: DealOutcome = 'blocked'
    if (deal.state === 'available' && deal.blockedReason === null) {
      if (!deal.assignment) outcome = 'create'
      else if (deal.assignment.intermediaryCustomerUserId === targetId) outcome = 'unchanged'
      else outcome = 'reassign'
    }
    return { deal, outcome }
  }), [preflight, targetId])
  const blockedCount = classified.filter((item) => item.outcome === 'blocked').length
  const reassignCount = classified.filter((item) => item.outcome === 'reassign').length
  const target = preflight?.intermediaries.find((intermediary) => intermediary.id === targetId) ?? null

  async function submit() {
    if (!preflight || !targetId || blockedCount > 0) return
    if (reassignCount > 0) {
      const accepted = await confirm({
        title: t('finoo_intermediaries.bulk.confirm.title', 'Reassign selected Deals?'),
        text: t('finoo_intermediaries.bulk.confirm.text', '{count} existing assignments will be changed to {target}.', {
          count: reassignCount,
          target: target?.displayName ?? '',
        }),
        variant: 'destructive',
      })
      if (!accepted) return
    }
    setSaving(true)
    setError(null)
    let queued = false
    try {
      const result = await runMutation({
        context: { retryLastMutation },
        mutationPayload: { targetId, dealCount: preflight.deals.length },
        operation: () => readApiResultOrThrow<{ progressJobId?: string; unchangedCount?: number }>(
          '/api/finoo_intermediaries/admin/bulk-assignments',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              intermediaryCustomerUserId: targetId,
              confirmReassign: reassignCount > 0,
              deals: preflight.deals.flatMap((deal) => deal.state === 'available'
                ? [{
                    id: deal.id,
                    updatedAt: deal.updatedAt,
                    assignmentId: deal.assignment?.id ?? null,
                    assignmentUpdatedAt: deal.assignment?.updatedAt ?? null,
                  }]
                : []),
            }),
          },
        ),
      })
      if (!result) return
      if (result.progressJobId) {
        queued = true
        progressJobIdRef.current = result.progressJobId
        setProgressJobId(result.progressJobId)
        flash(t('finoo_intermediaries.bulk.queued', 'Bulk assignment started. Progress is visible in the top bar.'), 'success')
      } else {
        flash(t('finoo_intermediaries.bulk.unchanged', 'The selected Deals are already assigned to this intermediary.'), 'success')
        window.location.assign('/backend/customers/deals')
      }
    } catch (caught) {
      if (!surfaceRecordConflict(caught, t, { onRefresh: load })) {
        const message = t('finoo_intermediaries.bulk.errors.save', 'Unable to assign the selected Deals. Review the list and try again.')
        setError(message)
        flash(message, 'error')
      }
    } finally {
      if (!queued) setSaving(false)
    }
  }

  if (loading) return <LoadingMessage label={t('finoo_intermediaries.bulk.loading', 'Loading selected Deals…')} />
  if (!preflight || error && preflight === null) return (
    <ErrorMessage
      label={error ?? t('finoo_intermediaries.bulk.errors.load', 'Unable to load the selected Deals.')}
      action={<Button variant="outline" size="sm" onClick={() => void load()}>{t('finoo_intermediaries.bulk.retry', 'Try again')}</Button>}
    />
  )

  return (
    <div
      className="mx-auto flex w-full max-w-4xl flex-col gap-6"
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
          event.preventDefault()
          void submit()
        }
      }}
    >
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('finoo_intermediaries.bulk.title', 'Assign selected Deals')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('finoo_intermediaries.bulk.description', 'Choose one intermediary for all eligible selected Deals.')}</p>
      </div>
      {error ? <Alert status="error" style="lighter">{error}</Alert> : null}
      {progressJobId ? <Alert status="information" style="lighter">{t('finoo_intermediaries.bulk.queued', 'Bulk assignment started. Progress is visible in the top bar.')}</Alert> : null}
      {blockedCount > 0 ? <Alert status="warning" style="lighter">{t('finoo_intermediaries.bulk.blockedSummary', '{count} Deals cannot be assigned. Remove them or move them to the eligible stage.', { count: blockedCount })}</Alert> : null}
      <FormField label={t('finoo_intermediaries.bulk.intermediary', 'Intermediary')} required>
        <Select value={targetId} onValueChange={setTargetId}>
          <SelectTrigger><SelectValue placeholder={t('finoo_intermediaries.bulk.selectIntermediary', 'Select intermediary')} /></SelectTrigger>
          <SelectContent>
            {preflight.intermediaries.map((intermediary) => (
              <SelectItem key={intermediary.id} value={intermediary.id}>{intermediary.displayName} · {intermediary.email}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>
      <div className="divide-y divide-border rounded-lg border border-border">
        {classified.map(({ deal, outcome }) => (
          <div key={deal.id} className="flex items-center justify-between gap-4 px-4 py-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{deal.name ?? t('finoo_intermediaries.bulk.unavailableDeal', 'Unavailable Deal')}</p>
              {deal.state === 'available' && deal.assignment ? <p className="truncate text-xs text-muted-foreground">{deal.assignment.intermediaryDisplayName ?? t('finoo_intermediaries.bulk.currentUnknown', 'Current intermediary')}</p> : null}
            </div>
            <StatusBadge variant={outcomeMap[outcome]}>{t(`finoo_intermediaries.bulk.outcome.${outcome}`, outcome)}</StatusBadge>
          </div>
        ))}
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={() => router.push('/backend/customers/deals')} disabled={saving}>{t('common.cancel', 'Cancel')}</Button>
        <Button onClick={() => void submit()} disabled={saving || !targetId || blockedCount > 0}>{saving ? t('finoo_intermediaries.bulk.saving', 'Starting…') : t('finoo_intermediaries.bulk.submit', 'Assign selected Deals')}</Button>
      </div>
      {ConfirmDialogElement}
    </div>
  )
}
