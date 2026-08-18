"use client"

import * as React from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import { Alert } from '@open-mercato/ui/primitives/alert'
import { Button } from '@open-mercato/ui/primitives/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@open-mercato/ui/primitives/dialog'
import { payoutErrorMessage } from './payout-error'

export type PayoutPreviewGroup = {
  paymentReference: string
  affiliateId: string
  affiliateEmail: string
  affiliateUpdatedAt: string
  accountHolderName: string
  accountNumber: string
  amount: string
  currency: 'PLN'
  selectedCount: number
  transactions: Array<{ id: string; updatedAt: string }>
  expiresAt: string
}

export type PayoutPreview = {
  batchId: string | null
  groups: PayoutPreviewGroup[]
  selectedCount: number
  affiliateCount: number
  totalAmount: string
  currency: 'PLN'
}

export type PayoutPreviewResponse = Partial<PayoutPreviewGroup> & Partial<PayoutPreview> & {
  batchId?: string
  currency: 'PLN'
  selectedCount: number
}

export function normalizePayoutPreview(response: PayoutPreviewResponse): PayoutPreview {
  if (Array.isArray(response.groups) && typeof response.batchId === 'string' && typeof response.affiliateCount === 'number' && typeof response.totalAmount === 'string') {
    return {
      batchId: response.batchId,
      groups: response.groups,
      selectedCount: response.selectedCount,
      affiliateCount: response.affiliateCount,
      totalAmount: response.totalAmount,
      currency: response.currency,
    }
  }
  if (
    typeof response.paymentReference === 'string'
    && typeof response.affiliateId === 'string'
    && typeof response.affiliateEmail === 'string'
    && typeof response.affiliateUpdatedAt === 'string'
    && typeof response.accountHolderName === 'string'
    && typeof response.accountNumber === 'string'
    && typeof response.amount === 'string'
    && Array.isArray(response.transactions)
    && typeof response.expiresAt === 'string'
  ) {
    const group = response as PayoutPreviewGroup
    return { batchId: response.batchId ?? null, groups: [group], selectedCount: group.selectedCount, affiliateCount: 1, totalAmount: group.amount, currency: group.currency }
  }
  throw new Error('[internal] Invalid payout preview response')
}

export default function PayoutPreviewDialog({
  preview,
  onComplete,
  onCancel,
}: {
  preview: PayoutPreview
  onComplete: (result: { progressJobId?: string }) => void
  onCancel: () => void
}) {
  const t = useT()
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const { runMutation, retryLastMutation } = useGuardedMutation({ contextId: 'finoo-affiliate-payout-confirm' })

  const confirm = React.useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const groups = preview.groups.map(({ paymentReference, affiliateUpdatedAt, transactions }) => ({ paymentReference, affiliateUpdatedAt, transactions }))
      const payload = preview.batchId ? { batchId: preview.batchId, groups } : groups[0]
      const result = await runMutation({
        operation: () => readApiResultOrThrow<{ progressJobId?: string }>('/api/finoo_affiliates/payouts/confirm', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
        }),
        context: { recordId: preview.groups.map((group) => group.paymentReference).sort().join(','), retryLastMutation },
        mutationPayload: payload,
      })
      onComplete(result)
    } catch (caught) {
      setError(payoutErrorMessage(caught, t))
    } finally {
      setBusy(false)
    }
  }, [onComplete, preview.batchId, preview.groups, retryLastMutation, runMutation, t])

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onCancel() }}>
      <DialogContent dismissible={!busy} onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void confirm() }
      }}>
        <DialogHeader>
          <DialogTitle>{t('finooAffiliates.payouts.confirmTitle', 'Confirm payout')}</DialogTitle>
          <DialogDescription>{t('finooAffiliates.payouts.confirmDescription', 'Verify every transfer before confirming.')}</DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <dt>{t('finooAffiliates.payouts.affiliateCount', 'Affiliates')}</dt><dd>{preview.affiliateCount}</dd>
          <dt>{t('finooAffiliates.payouts.selectedCount', 'Transactions')}</dt><dd>{preview.selectedCount}</dd>
          <dt>{t('finooAffiliates.payouts.totalAmount', 'Total amount')}</dt><dd>{preview.totalAmount} {preview.currency}</dd>
        </dl>
        <div className="max-h-96 divide-y divide-border overflow-y-auto border-y border-border">
          {preview.groups.map((group) => (
            <dl key={group.paymentReference} className="grid grid-cols-2 gap-3 py-4 text-sm">
              <dt>{t('finooAffiliates.payouts.affiliate', 'Affiliate')}</dt><dd>{group.affiliateEmail}</dd>
              <dt>{t('finooAffiliates.payouts.amount', 'Amount')}</dt><dd>{group.amount} {group.currency}</dd>
              <dt>{t('finooAffiliates.payouts.accountHolder', 'Account holder')}</dt><dd>{group.accountHolderName}</dd>
              <dt>{t('finooAffiliates.payouts.accountNumber', 'Account number')}</dt><dd>{group.accountNumber}</dd>
              <dt>{t('finooAffiliates.payouts.reference', 'Reference')}</dt><dd>{group.paymentReference}</dd>
              <dt>{t('finooAffiliates.payouts.selectedCount', 'Transactions')}</dt><dd>{group.selectedCount}</dd>
            </dl>
          ))}
        </div>
        {error ? <Alert status="error">{error}</Alert> : null}
        <Alert status="warning">{t('finooAffiliates.payouts.confirmWarning', 'Please only confirm if every payment was actually made.')}</Alert>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>{t('finooAffiliates.common.cancel', 'Cancel')}</Button>
          <Button type="button" disabled={busy} onClick={() => void confirm()}>{busy ? t('finooAffiliates.payouts.confirming', 'Confirming…') : t('finooAffiliates.payouts.confirm', 'Confirm')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
