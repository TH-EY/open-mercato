"use client"
import * as React from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { Button } from '@open-mercato/ui/primitives/button'
import { Alert } from '@open-mercato/ui/primitives/alert'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@open-mercato/ui/primitives/dialog'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'

export type PayoutPreview = { paymentReference: string; affiliateEmail: string; affiliateUpdatedAt: string; accountHolderName: string; accountNumber: string; amount: string; currency: 'PLN'; selectedCount: number; transactions: Array<{ id: string; updatedAt: string }> }

export default function PayoutPreviewDialog({ preview, onComplete, onCancel }: { preview: PayoutPreview; onComplete: (result: { progressJobId?: string }) => void; onCancel: () => void }) {
  const t = useT(); const [busy, setBusy] = React.useState(false)
  const { runMutation, retryLastMutation } = useGuardedMutation({ contextId: 'finoo-affiliate-payout-confirm' })
  const confirm = React.useCallback(async () => {
    setBusy(true)
    try {
      const payload = { paymentReference: preview.paymentReference, affiliateUpdatedAt: preview.affiliateUpdatedAt, transactions: preview.transactions }
      const result = await runMutation({
        operation: () => readApiResultOrThrow<{ progressJobId?: string }>('/api/finoo_affiliates/payouts/confirm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }),
        context: { recordId: preview.paymentReference, retryLastMutation }, mutationPayload: payload,
      })
      onComplete(result)
    } finally { setBusy(false) }
  }, [onComplete, preview, retryLastMutation, runMutation])
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onCancel() }}><DialogContent dismissible={!busy} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void confirm() } }}>
    <DialogHeader><DialogTitle>{t('finooAffiliates.payouts.confirmTitle', 'Confirm payout')}</DialogTitle><DialogDescription>{t('finooAffiliates.payouts.confirmDescription', 'Verify the transfer details before confirming.')}</DialogDescription></DialogHeader>
    <dl className="grid grid-cols-2 gap-3 text-sm"><dt>{t('finooAffiliates.payouts.affiliate', 'Affiliate')}</dt><dd>{preview.affiliateEmail}</dd><dt>{t('finooAffiliates.payouts.amount', 'Amount')}</dt><dd>{preview.amount} {preview.currency}</dd><dt>{t('finooAffiliates.payouts.accountHolder', 'Account holder')}</dt><dd>{preview.accountHolderName}</dd><dt>{t('finooAffiliates.payouts.accountNumber', 'Account number')}</dt><dd>{preview.accountNumber}</dd><dt>{t('finooAffiliates.payouts.reference', 'Reference')}</dt><dd>{preview.paymentReference}</dd><dt>{t('finooAffiliates.payouts.selectedCount', 'Transactions')}</dt><dd>{preview.selectedCount}</dd></dl>
    <Alert status="warning">{t('finooAffiliates.payouts.confirmWarning', 'Please only Confirm if the payment was actually made')}</Alert>
    <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={onCancel}>{t('finooAffiliates.common.cancel', 'Cancel')}</Button><Button type="button" disabled={busy} onClick={() => void confirm()}>{busy ? t('finooAffiliates.payouts.confirming', 'Confirming…') : t('finooAffiliates.payouts.confirm', 'Confirm')}</Button></DialogFooter>
  </DialogContent></Dialog>
}
