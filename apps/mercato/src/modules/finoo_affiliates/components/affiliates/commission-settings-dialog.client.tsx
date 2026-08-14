"use client"

import * as React from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { surfaceRecordConflict } from '@open-mercato/ui/backend/conflicts'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import { readApiResultOrThrow, withScopedApiRequestHeaders } from '@open-mercato/ui/backend/utils/apiCall'
import { buildOptimisticLockHeader } from '@open-mercato/ui/backend/utils/optimisticLock'
import { AmountInput } from '@open-mercato/ui/primitives/amount-input'
import { Button } from '@open-mercato/ui/primitives/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@open-mercato/ui/primitives/dialog'
import { Input } from '@open-mercato/ui/primitives/input'
import { Label } from '@open-mercato/ui/primitives/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@open-mercato/ui/primitives/select'

export type AffiliateCommissionSettings = {
  id: string
  email: string
  commissionMode: 'percentage' | 'fixed' | null
  commissionRateBps: number | null
  commissionFixedAmount: number | null
  updatedAt: string
}

type MutationContext = {
  resourceKind: string
  resourceId: string
  retryLastMutation: () => Promise<boolean>
}

type AffiliateCommissionUpdateResponse = Omit<AffiliateCommissionSettings, 'email'>

const PLN_CURRENCY = [{ code: 'PLN', symbol: 'zł', label: 'PLN' }]

function percentageValue(rateBps: number | null): string {
  return rateBps === null ? '' : String(rateBps / 100)
}

function parsePercentageBps(value: string): number | null {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value)
  if (!match) return null
  const whole = Number(match[1])
  const fraction = Number((match[2] ?? '').padEnd(2, '0') || '0')
  if (!Number.isSafeInteger(whole)) return null
  const rateBps = whole * 100 + fraction
  return Number.isSafeInteger(rateBps) ? rateBps : null
}

export default function CommissionSettingsDialog({
  affiliate,
  onOpenChange,
  onSaved,
}: {
  affiliate: AffiliateCommissionSettings | null
  onOpenChange: (open: boolean) => void
  onSaved: (settings: AffiliateCommissionSettings) => void
}) {
  const t = useT()
  const [mode, setMode] = React.useState<'percentage' | 'fixed'>('percentage')
  const [percentage, setPercentage] = React.useState('')
  const [fixedAmount, setFixedAmount] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const { runMutation, retryLastMutation } = useGuardedMutation<MutationContext>({
    contextId: `finoo-affiliate-commission:${affiliate?.id ?? 'closed'}`,
  })

  React.useEffect(() => {
    if (!affiliate) return
    setMode(affiliate.commissionMode ?? 'percentage')
    setPercentage(percentageValue(affiliate.commissionRateBps))
    setFixedAmount(affiliate.commissionFixedAmount === null ? '' : String(affiliate.commissionFixedAmount))
    setError(null)
  }, [affiliate])

  const close = React.useCallback(() => {
    if (!saving) onOpenChange(false)
  }, [onOpenChange, saving])

  const submit = React.useCallback(async (event: React.FormEvent) => {
    event.preventDefault()
    if (!affiliate || saving) return
    const normalizedPercentage = percentage.trim()
    const normalizedFixedAmount = fixedAmount.trim()
    const rateBps = parsePercentageBps(normalizedPercentage)
    const fixed = Number(normalizedFixedAmount)
    if (mode === 'percentage' && (
      rateBps === null
      || rateBps < 1
      || rateBps > 10_000
    )) {
      setError(t('finooAffiliates.affiliates.commissionPercentageError', 'Enter a percentage greater than 0 and at most 100 with up to two decimals.'))
      return
    }
    if (mode === 'fixed' && (
      !/^\d+$/.test(normalizedFixedAmount)
      || !Number.isSafeInteger(fixed)
      || fixed < 0
      || fixed > 2_147_483_647
    )) {
      setError(t('finooAffiliates.affiliates.commissionFixedError', 'Enter a non-negative whole PLN amount.'))
      return
    }
    const payload = {
      id: affiliate.id,
      commissionMode: mode,
      commissionRateBps: mode === 'percentage' ? rateBps : null,
      commissionFixedAmount: mode === 'fixed' ? fixed : null,
      updatedAt: affiliate.updatedAt,
    }
    setSaving(true)
    setError(null)
    try {
      const result = await runMutation({
        operation: () => withScopedApiRequestHeaders(
          buildOptimisticLockHeader(affiliate.updatedAt),
          () => readApiResultOrThrow<AffiliateCommissionUpdateResponse>('/api/finoo_affiliates/affiliates', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          }),
        ),
        mutationPayload: payload,
        context: {
          resourceKind: 'finoo_affiliates.affiliate',
          resourceId: affiliate.id,
          retryLastMutation,
        },
      })
      onSaved({ ...affiliate, ...result })
      flash(t('finooAffiliates.affiliates.commissionSaved', 'Affiliate commission rule saved.'), 'success')
      onOpenChange(false)
    } catch (caught) {
      if (!surfaceRecordConflict(caught, t)) {
        setError(t('finooAffiliates.affiliates.commissionSaveError', 'Unable to save the affiliate commission rule.'))
      }
    } finally {
      setSaving(false)
    }
  }, [affiliate, fixedAmount, mode, onOpenChange, onSaved, percentage, retryLastMutation, runMutation, saving, t])

  const handleKeyDown = React.useCallback((event: React.KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault()
      const form = (event.target as HTMLElement).closest('form')
      form?.requestSubmit()
    }
  }, [])

  return (
    <Dialog open={Boolean(affiliate)} onOpenChange={(open) => { if (!open) close() }}>
      <DialogContent dismissible={!saving}>
        <DialogHeader>
          <DialogTitle>{t('finooAffiliates.affiliates.commissionTitle', 'Edit commission rule')}</DialogTitle>
          <DialogDescription>
            {t('finooAffiliates.affiliates.commissionDescription', 'The new rule applies only to future accepted transactions.')}
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={(event) => { void submit(event) }} onKeyDown={handleKeyDown}>
          <div className="space-y-2">
            <Label htmlFor="affiliate-commission-mode">{t('finooAffiliates.affiliates.commissionMode', 'Commission type')}</Label>
            <Select value={mode} onValueChange={(value) => setMode(value as 'percentage' | 'fixed')} disabled={saving}>
              <SelectTrigger id="affiliate-commission-mode"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="percentage">{t('finooAffiliates.affiliates.commissionPercentage', 'Percentage')}</SelectItem>
                <SelectItem value="fixed">{t('finooAffiliates.affiliates.commissionFixed', 'Fixed amount')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {mode === 'percentage' ? (
            <div className="space-y-2">
              <Label htmlFor="affiliate-commission-percentage">{t('finooAffiliates.affiliates.commissionPercentageLabel', 'Percentage')}</Label>
              <Input
                id="affiliate-commission-percentage"
                type="number"
                inputMode="decimal"
                min="0.01"
                max="100"
                step="0.01"
                value={percentage}
                onChange={(event) => setPercentage(event.target.value)}
                disabled={saving}
                required
                autoFocus
              />
            </div>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="affiliate-commission-fixed">{t('finooAffiliates.affiliates.commissionFixedLabel', 'Fixed commission')}</Label>
              <AmountInput
                id="affiliate-commission-fixed"
                value={{ amount: fixedAmount, currency: 'PLN' }}
                onChange={(value) => setFixedAmount(value.amount)}
                currencies={PLN_CURRENCY}
                showCurrency={false}
                inputMode="numeric"
                disabled={saving}
                required
                autoFocus
              />
            </div>
          )}
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close} disabled={saving}>
              {t('finooAffiliates.common.cancel', 'Cancel')}
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? t('finooAffiliates.common.saving', 'Saving…') : t('finooAffiliates.common.save', 'Save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
