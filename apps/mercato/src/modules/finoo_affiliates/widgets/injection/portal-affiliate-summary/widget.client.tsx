"use client"
import * as React from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { Button } from '@open-mercato/ui/primitives/button'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
type Payload = { totalPaidOut: string; pendingPayout: string; currency: string; generatedLink: { code: string; trackedUrl: string } | null }
export default function PortalAffiliateSummaryWidget() {
  const t = useT(); const [data, setData] = React.useState<Payload | null>(null)
  React.useEffect(() => { void readApiResultOrThrow<Payload>('/api/finoo_affiliates/portal/dashboard').then(setData) }, [])
  if (!data) return null
  return <div className="space-y-4"><div className="grid gap-4 sm:grid-cols-2"><div><p className="text-sm text-muted-foreground">{t('finooAffiliates.portal.dashboard.totalPaidOut', 'Total paid out')}</p><p className="text-2xl font-semibold">{data.totalPaidOut} {data.currency}</p></div><div><p className="text-sm text-muted-foreground">{t('finooAffiliates.portal.dashboard.pendingPayout', 'Pending payout')}</p><p className="text-2xl font-semibold">{data.pendingPayout} {data.currency}</p></div></div>{data.generatedLink ? <div><p className="text-sm font-medium">{t('finooAffiliates.portal.dashboard.individualLink', 'Individual link')}</p><div className="flex flex-wrap items-center gap-2"><code className="text-sm">{data.generatedLink.trackedUrl}</code><Button type="button" size="sm" variant="outline" onClick={() => { void navigator.clipboard.writeText(data.generatedLink?.trackedUrl ?? ''); flash(t('finooAffiliates.portal.dashboard.linkCopied', 'Link copied.'), 'success') }}>{t('finooAffiliates.portal.dashboard.copyLink', 'Copy link')}</Button></div></div> : <p className="text-sm text-muted-foreground">{t('finooAffiliates.portal.dashboard.linkInactive', 'Your individual link is not active yet.')}</p>}</div>
}
