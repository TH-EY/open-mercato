"use client"

import * as React from 'react'
import type { InjectionWidgetComponentProps } from '@open-mercato/shared/modules/widgets/injection'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { withScopedApiRequestHeaders } from '@open-mercato/ui/backend/utils/apiCall'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { buildOptimisticLockHeader } from '@open-mercato/ui/backend/utils/optimisticLock'
import { surfaceRecordConflict } from '@open-mercato/ui/backend/conflicts'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { Label } from '@open-mercato/ui/primitives/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@open-mercato/ui/primitives/select'

type Option = { id: string; displayName?: string; email?: string; value?: string; label?: string }
type Attribution = {
  id: string
  affiliateUserId: string
  affiliateCode: string
  landingPage: string | null
  initialReferrer: string | null
  commissionStatusEntryId: string
  commissionAmount: number
  affiliateProgramStatus: 'processing' | 'approved' | 'rejected' | 'paid_out'
  affiliateTransactionId: string | null
  affiliateTransactionAmount: number | null
  updatedAt: string
}
type EditorPayload = { attribution: Attribution | null; affiliates: Option[]; statuses: Option[] }
export type WidgetContext = { dealId?: string | null; resourceId?: string | null }

function readDealId(context: WidgetContext | undefined): string | null {
  return context?.dealId ?? context?.resourceId ?? null
}

export default function DealAttributionWidget({ context, disabled }: InjectionWidgetComponentProps<WidgetContext>) {
  const t = useT()
  const dealId = readDealId(context)
  const [data, setData] = React.useState<EditorPayload | null>(null)
  const [affiliateUserId, setAffiliateUserId] = React.useState('')
  const [commissionStatusEntryId, setCommissionStatusEntryId] = React.useState('')
  const [commissionAmount, setCommissionAmount] = React.useState('0')
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const { runMutation, retryLastMutation } = useGuardedMutation<WidgetContext & { retryLastMutation: () => Promise<boolean> }>({
    contextId: `finoo-affiliate-deal:${dealId ?? 'unknown'}`,
  })

  const load = React.useCallback(async () => {
    if (!dealId) return
    setLoading(true)
    setError(null)
    try {
      const payload = await readApiResultOrThrow<EditorPayload>(`/api/finoo_affiliates/deal-attributions?dealId=${encodeURIComponent(dealId)}`)
      setData(payload)
      setAffiliateUserId(payload.attribution?.affiliateUserId ?? '')
      setCommissionStatusEntryId(
        payload.attribution?.commissionStatusEntryId
          ?? payload.statuses.find((status) => status.value === 'waiting')?.id
          ?? '',
      )
      setCommissionAmount(String(payload.attribution?.commissionAmount ?? 0))
    } catch {
      setError(t('finooAffiliates.deal.loadError', 'Unable to load affiliate commission data.'))
    } finally {
      setLoading(false)
    }
  }, [dealId, t])

  React.useEffect(() => {
    void load()
  }, [load])

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (!dealId || !affiliateUserId || !commissionStatusEntryId) return
    const payload = {
      dealId,
      affiliateUserId,
      commissionStatusEntryId,
      commissionAmount: Number(commissionAmount),
    }
    setSaving(true)
    setError(null)
    try {
      await runMutation({
        operation: () => withScopedApiRequestHeaders(
          buildOptimisticLockHeader(data?.attribution?.updatedAt ?? null),
          () => readApiResultOrThrow('/api/finoo_affiliates/deal-attributions', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          }),
        ),
        mutationPayload: payload,
        context: { dealId, resourceId: dealId, retryLastMutation },
      })
      flash(t('finooAffiliates.deal.saved', 'Affiliate commission saved.'), 'success')
      await load()
    } catch (caught) {
      if (!surfaceRecordConflict(caught, t)) {
        setError(t('finooAffiliates.deal.saveError', 'Unable to save affiliate commission data.'))
      }
    } finally {
      setSaving(false)
    }
  }

  if (!dealId) return null
  if (loading) return <p className="text-sm text-muted-foreground">{t('finooAffiliates.common.loading', 'Loading…')}</p>

  return (
    <form className="max-w-2xl space-y-5" onSubmit={handleSubmit}>
      <div className="space-y-1.5">
        <Label htmlFor="finoo-affiliate-user">{t('finooAffiliates.deal.affiliateUser', 'Affiliate user')}</Label>
        <Select value={affiliateUserId} onValueChange={setAffiliateUserId} disabled={disabled || saving}>
          <SelectTrigger id="finoo-affiliate-user"><SelectValue placeholder={t('finooAffiliates.deal.selectAffiliate', 'Select an affiliate')} /></SelectTrigger>
          <SelectContent>
            {(data?.affiliates ?? []).map((affiliate) => (
              <SelectItem key={affiliate.id} value={affiliate.id}>{affiliate.displayName || affiliate.email || affiliate.id}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {data?.attribution ? (
        <dl className="grid gap-4 border-t border-border pt-4 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-muted-foreground">{t('finooAffiliates.deal.affiliateCode', 'Affiliate code')}</dt>
            <dd className="mt-1 break-all font-mono">{data.attribution.affiliateCode || '—'}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t('finooAffiliates.portal.leads.landingPage', 'Landing page')}</dt>
            <dd className="mt-1 break-all">{data.attribution.landingPage || '—'}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t('finooAffiliates.portal.leads.initialReferrer', 'Initial referrer')}</dt>
            <dd className="mt-1 break-all">{data.attribution.initialReferrer || '—'}</dd>
          </div>
        </dl>
      ) : null}
      {data?.attribution?.affiliateTransactionId ? (
        <dl className="grid gap-4 border-t border-border pt-4 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">{t('finooAffiliates.transactions.status', 'Commission status')}</dt>
            <dd className="mt-1">{t(`finooAffiliates.transactions.statuses.${data.attribution.affiliateProgramStatus}`, data.attribution.affiliateProgramStatus)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t('finooAffiliates.transactions.amount', 'Commission amount')}</dt>
            <dd className="mt-1">{data.attribution.affiliateTransactionAmount?.toLocaleString() ?? '—'} PLN</dd>
          </div>
        </dl>
      ) : null}
      <div className="space-y-1.5">
        <Label htmlFor="finoo-commission-status">{t('finooAffiliates.deal.commissionStatus', 'Commission status')}</Label>
        <Select value={commissionStatusEntryId} onValueChange={setCommissionStatusEntryId} disabled={disabled || saving}>
          <SelectTrigger id="finoo-commission-status"><SelectValue /></SelectTrigger>
          <SelectContent>
            {(data?.statuses ?? []).map((status) => (
              <SelectItem key={status.id} value={status.id}>{status.label || status.value || status.id}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="finoo-commission-amount">{t('finooAffiliates.deal.commissionAmount', 'Commission amount')}</Label>
        <Input
          id="finoo-commission-amount"
          type="number"
          min={0}
          step={1}
          value={commissionAmount}
          onChange={(event) => setCommissionAmount(event.target.value)}
          disabled={disabled || saving}
          required
        />
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <Button type="submit" disabled={disabled || saving || !affiliateUserId || !commissionStatusEntryId}>
        {saving ? t('finooAffiliates.common.saving', 'Saving…') : t('finooAffiliates.common.save', 'Save')}
      </Button>
    </form>
  )
}
