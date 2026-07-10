"use client"

import * as React from 'react'
import { AlertCircle, CalendarCheck, CalendarClock, CheckCircle2, RefreshCw } from 'lucide-react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import type { InjectionWidgetComponentProps } from '@open-mercato/shared/modules/widgets/injection'
import { Button } from '@open-mercato/ui/primitives/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@open-mercato/ui/primitives/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@open-mercato/ui/primitives/select'
import { Spinner } from '@open-mercato/ui/primitives/spinner'
import { apiCallOrThrow, withScopedApiRequestHeaders } from '@open-mercato/ui/backend/utils/apiCall'
import { buildOptimisticLockHeader } from '@open-mercato/ui/backend/utils/optimisticLock'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import {
  EPC_SURVEY_BOOKING_ENDPOINT,
  type EpcSurveyBookingDeal,
  type EpcSurveyBookingPostResponse,
  type EpcSurveyBookingRecord,
  type EpcSurveyBookingSlot,
  type EpcSurveyBookingState,
} from '../../../lib/surveyBookingTypes'

export type EpcSurveyBookingWidgetContext = {
  orgSlug?: string
}

type WidgetProps = InjectionWidgetComponentProps<EpcSurveyBookingWidgetContext>

export function submitSurveyBookingRequest(params: {
  dealId: string
  slotId: string
  bookedSurvey: EpcSurveyBookingRecord | null
}) {
  const call = () => apiCallOrThrow<EpcSurveyBookingPostResponse>(EPC_SURVEY_BOOKING_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dealId: params.dealId, slotId: params.slotId }),
  })
  return params.bookedSurvey
    ? withScopedApiRequestHeaders(buildOptimisticLockHeader(params.bookedSurvey.updatedAt), call)
    : call()
}

export default function EpcSurveyBookingWidget(_props: WidgetProps) {
  const t = useT()
  const [state, setState] = React.useState<EpcSurveyBookingState | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [open, setOpen] = React.useState(false)
  const [selectedDealId, setSelectedDealId] = React.useState<string | null>(null)
  const [selectedSlotId, setSelectedSlotId] = React.useState<string | null>(null)
  const [saving, setSaving] = React.useState(false)

  const { runMutation } = useGuardedMutation<Record<string, unknown>>({
    contextId: 'epc-demo-survey-booking',
  })

  const loadState = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await apiCallOrThrow<EpcSurveyBookingState>(EPC_SURVEY_BOOKING_ENDPOINT)
      if (response.result) {
        setState(response.result)
        setSelectedDealId((current) => current ?? response.result?.deals[0]?.id ?? null)
        setSelectedSlotId((current) => current ?? response.result?.slots[0]?.id ?? null)
      }
    } catch {
      setError(t('epcDemo.surveyBooking.errors.load', 'Survey booking could not be loaded.'))
    } finally {
      setLoading(false)
    }
  }, [t])

  React.useEffect(() => {
    void loadState()
  }, [loadState])

  const selectedDeal = React.useMemo(() => {
    if (!state?.deals.length) return null
    return state.deals.find((deal) => deal.id === selectedDealId) ?? state.deals[0]
  }, [selectedDealId, state?.deals])

  const selectedSlot = React.useMemo(() => {
    if (!state?.slots.length) return null
    return state.slots.find((slot) => slot.id === selectedSlotId) ?? state.slots[0]
  }, [selectedSlotId, state?.slots])

  React.useEffect(() => {
    if (!state) return
    if (!selectedDealId && state.deals[0]) setSelectedDealId(state.deals[0].id)
    if (!selectedSlotId && state.slots[0]) setSelectedSlotId(state.slots[0].id)
  }, [selectedDealId, selectedSlotId, state])

  const submit = React.useCallback(async () => {
    if (!selectedDeal || !selectedSlot) return
    setSaving(true)
    setError(null)
    try {
      const result = await runMutation({
        operation: () => submitSurveyBookingRequest({
          dealId: selectedDeal.id,
          slotId: selectedSlot.id,
          bookedSurvey: selectedDeal.bookedSurvey,
        }),
        context: {
          operation: selectedDeal.bookedSurvey ? 'rescheduleSurvey' : 'bookSurvey',
          dealId: selectedDeal.id,
          slotId: selectedSlot.id,
        },
        mutationPayload: {
          dealId: selectedDeal.id,
          slotId: selectedSlot.id,
        },
      })
      if (result.result?.state) {
        setState(result.result.state)
        setSelectedDealId(selectedDeal.id)
        setSelectedSlotId(result.result.state.slots[0]?.id ?? null)
      }
      setOpen(false)
    } catch {
      setError(t('epcDemo.surveyBooking.errors.book', 'The selected survey slot is no longer available.'))
    } finally {
      setSaving(false)
    }
  }, [runMutation, selectedDeal, selectedSlot, t])

  if (loading) {
    return (
      <div className="flex min-h-24 items-center justify-center">
        <Spinner />
      </div>
    )
  }

  if (error && !state) {
    return (
      <div className="flex items-start gap-3 rounded-md border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive">
        <AlertCircle className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0">
          <p>{error}</p>
          <Button type="button" variant="destructive-soft" size="sm" className="mt-3" onClick={() => void loadState()}>
            <RefreshCw className="size-4" />
            {t('epcDemo.surveyBooking.actions.retry', 'Retry')}
          </Button>
        </div>
      </div>
    )
  }

  if (!state) return null

  const hasDeals = state.deals.length > 0
  const hasSlots = state.slots.length > 0
  const bookedSurvey = selectedDeal?.bookedSurvey ?? null
  const actionLabel = bookedSurvey
    ? t('epcDemo.surveyBooking.actions.reschedule', 'Change time')
    : t('epcDemo.surveyBooking.actions.book', 'Book survey')

  return (
    <div className="flex min-h-40 min-w-0 max-w-full flex-col gap-4 overflow-hidden">
      {hasDeals ? (
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-md border bg-background">
            {bookedSurvey ? <CheckCircle2 className="size-5 text-emerald-600" /> : <CalendarClock className="size-5 text-primary" />}
          </div>
          <div className="min-w-0 flex-1">
            <p className="break-words text-sm font-medium [overflow-wrap:anywhere]">{selectedDeal?.title}</p>
            <p className="mt-1 break-words text-sm text-muted-foreground [overflow-wrap:anywhere]">
              {bookedSurvey
                ? t('epcDemo.surveyBooking.bookedFor', 'Booked for {{date}}', { date: formatDateTime(bookedSurvey.scheduledAt) })
                : t('epcDemo.surveyBooking.available', 'Survey stage is ready for booking.')}
            </p>
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-3 text-sm text-muted-foreground">
          <CalendarClock className="mt-0.5 size-4 shrink-0" />
          <p>{messageForReason(state.reason, t)}</p>
        </div>
      )}

      {error ? (
        <div className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <div className="mt-auto flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          disabled={!hasDeals || !hasSlots}
          onClick={() => setOpen(true)}
        >
          <CalendarCheck className="size-4" />
          {actionLabel}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => void loadState()}>
          <RefreshCw className="size-4" />
          {t('epcDemo.surveyBooking.actions.refresh', 'Refresh')}
        </Button>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle>{t('epcDemo.surveyBooking.dialog.title', 'Survey appointment')}</DialogTitle>
            <DialogDescription>
              {selectedDeal?.bookedSurvey
                ? t('epcDemo.surveyBooking.dialog.rescheduleDescription', 'Choose a new available time.')
                : t('epcDemo.surveyBooking.dialog.bookDescription', 'Choose an available time.')}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            {state.deals.length > 1 ? (
              <label className="flex flex-col gap-2 text-sm">
                <span className="font-medium">{t('epcDemo.surveyBooking.fields.project', 'Project')}</span>
                <Select
                  value={selectedDeal?.id ?? ''}
                  onValueChange={setSelectedDealId}
                >
                  <SelectTrigger className="min-w-0">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {state.deals.map((deal) => (
                      <SelectItem key={deal.id} value={deal.id}>{deal.title}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
            ) : null}

            <div className="grid gap-2 sm:grid-cols-2">
              {state.slots.map((slot) => (
                <SlotButton
                  key={slot.id}
                  slot={slot}
                  selected={slot.id === selectedSlot?.id}
                  onSelect={() => setSelectedSlotId(slot.id)}
                />
              ))}
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={saving}>
              {t('epcDemo.surveyBooking.actions.cancel', 'Cancel')}
            </Button>
            <Button type="button" onClick={() => void submit()} disabled={!selectedDeal || !selectedSlot || saving}>
              {saving ? <Spinner className="size-4" /> : <CalendarCheck className="size-4" />}
              {selectedDeal?.bookedSurvey
                ? t('epcDemo.surveyBooking.actions.confirmReschedule', 'Update appointment')
                : t('epcDemo.surveyBooking.actions.confirmBook', 'Book appointment')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function SlotButton(props: {
  slot: EpcSurveyBookingSlot
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      className={[
        'flex min-h-14 min-w-0 items-center gap-3 rounded-md border px-3 py-2 text-left text-sm transition-colors',
        props.selected ? 'border-primary bg-primary/5 text-foreground' : 'bg-background hover:bg-muted',
      ].join(' ')}
      aria-pressed={props.selected}
      onClick={props.onSelect}
    >
      <CalendarClock className="size-4 shrink-0 text-primary" />
      <span className="min-w-0 break-words font-medium [overflow-wrap:anywhere]">{props.slot.label}</span>
    </button>
  )
}

function formatDateTime(value: string): string {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(parsed)
}

function messageForReason(reason: EpcSurveyBookingState['reason'], t: ReturnType<typeof useT>): string {
  switch (reason) {
    case 'not_linked':
      return t('epcDemo.surveyBooking.empty.notLinked', 'No linked customer project is available.')
    case 'not_in_survey_stage':
      return t('epcDemo.surveyBooking.empty.notSurvey', 'Survey booking appears when a project reaches Survey.')
    case 'no_surveyors':
      return t('epcDemo.surveyBooking.empty.noSurveyors', 'No surveyors are available yet.')
    case 'no_slots':
      return t('epcDemo.surveyBooking.empty.noSlots', 'No survey slots are available right now.')
    case 'ready':
    default:
      return t('epcDemo.surveyBooking.empty.default', 'Survey booking is unavailable right now.')
  }
}
