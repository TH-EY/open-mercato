type Translate = (key: string, fallback: string) => string

type IncompleteAffiliate = {
  affiliateEmail: string
  missingFields: Array<'accountHolderName' | 'accountNumber'>
}

function errorDetails(error: unknown): Record<string, unknown> | null {
  if (!error || typeof error !== 'object') return null
  const record = error as Record<string, unknown>
  const details = record.details
  return details && typeof details === 'object'
    ? { ...record, ...(details as Record<string, unknown>) }
    : record
}

function incompleteAffiliates(details: Record<string, unknown>): IncompleteAffiliate[] {
  if (!Array.isArray(details.affiliates)) return []
  return details.affiliates.flatMap((value) => {
    if (!value || typeof value !== 'object') return []
    const record = value as Record<string, unknown>
    if (typeof record.affiliateEmail !== 'string' || !Array.isArray(record.missingFields)) return []
    const missingFields = record.missingFields.filter(
      (field): field is 'accountHolderName' | 'accountNumber' => field === 'accountHolderName' || field === 'accountNumber',
    )
    return missingFields.length > 0 ? [{ affiliateEmail: record.affiliateEmail, missingFields }] : []
  })
}

export function payoutErrorMessage(error: unknown, t: Translate): string {
  const details = errorDetails(error)
  const code = typeof details?.error === 'string' ? details.error : null
  if (code === 'PAYOUT_PROFILES_INCOMPLETE' && details) {
    const accountHolder = t('finooAffiliates.payouts.missingAccountHolder', 'account holder')
    const accountNumber = t('finooAffiliates.payouts.missingAccountNumber', 'account number')
    const rows = incompleteAffiliates(details).map((affiliate) => {
      const labels = affiliate.missingFields.map((field) => field === 'accountHolderName' ? accountHolder : accountNumber)
      return `${affiliate.affiliateEmail}: ${labels.join(', ')}`
    })
    if (rows.length > 0) {
      return `${t('finooAffiliates.payouts.incompleteProfiles', 'Complete payout profiles before continuing')}: ${rows.join('; ')}`
    }
  }
  if (code === 'TRANSACTION_NOT_APPROVED') {
    return t('finooAffiliates.payouts.notApproved', 'At least one selected transaction is no longer approved.')
  }
  if (code === 'PAYOUT_PREVIEW_STALE') {
    return t('finooAffiliates.payouts.stale', 'Payout data changed. Refresh the list and create a new preview.')
  }
  if (code === 'AFFILIATE_NOT_FOUND') {
    return t('finooAffiliates.payouts.affiliateUnavailable', 'An affiliate is no longer available in this organization.')
  }
  if (code === 'PAYOUT_CURRENCY_MISMATCH') {
    return t('finooAffiliates.payouts.currencyMismatch', 'Only PLN transactions can be paid out together.')
  }
  return t('finooAffiliates.payouts.actionError', 'Unable to prepare or confirm the payout.')
}
