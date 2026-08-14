"use client"

import * as React from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { apiCall, readApiResultOrThrow, withScopedApiRequestHeaders } from '@open-mercato/ui/backend/utils/apiCall'
import { buildOptimisticLockHeader } from '@open-mercato/ui/backend/utils/optimisticLock'
import { raiseCrudError } from '@open-mercato/ui/backend/utils/serverErrors'
import { surfaceRecordConflict } from '@open-mercato/ui/backend/conflicts'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import { LoadingMessage, ErrorMessage } from '@open-mercato/ui/backend/detail'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { Button } from '@open-mercato/ui/primitives/button'
import { FormField } from '@open-mercato/ui/primitives/form-field'
import { Input } from '@open-mercato/ui/primitives/input'

type Profile = { accountHolderName: string; accountNumber: string; updatedAt: string }

export default function PortalProfileClient() {
  const t = useT()
  const [profile, setProfile] = React.useState<Profile | null>(null)
  const [error, setError] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const { runMutation, retryLastMutation } = useGuardedMutation({ contextId: 'finoo-affiliate-profile' })
  React.useEffect(() => { void readApiResultOrThrow<Profile>('/api/finoo_affiliates/portal/profile').then(setProfile).catch(() => setError(true)) }, [])
  if (error) return <ErrorMessage label={t('finooAffiliates.profile.loadError', 'Unable to load profile.')} />
  if (!profile) return <LoadingMessage label={t('finooAffiliates.common.loading', 'Loading…')} />
  const save = async () => {
    setSaving(true)
    try {
      const payload = profile
      const result = await runMutation({
        operation: async () => {
          const call = await withScopedApiRequestHeaders(buildOptimisticLockHeader(profile.updatedAt), () => apiCall('/api/finoo_affiliates/portal/profile', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }))
          if (!call.ok) await raiseCrudError(call.response, t('finooAffiliates.profile.saveError', 'Unable to save profile.'))
          return call.result as Profile
        },
        context: { recordId: 'own-profile', retryLastMutation }, mutationPayload: payload,
      })
      setProfile(result)
      flash(t('finooAffiliates.profile.saved', 'Profile saved.'), 'success')
    } catch (caught) { if (!surfaceRecordConflict(caught, t)) flash(t('finooAffiliates.profile.saveError', 'Unable to save profile.'), 'error') } finally { setSaving(false) }
  }
  return <div className="mx-auto max-w-2xl space-y-6 p-6">
    <div><h1 className="text-2xl font-semibold">{t('finooAffiliates.profile.title', 'Profile')}</h1><p className="text-sm text-muted-foreground">{t('finooAffiliates.profile.description', 'Complete both fields before requesting a payout.')}</p></div>
    <FormField label={t('finooAffiliates.profile.accountHolderName', 'Account holder name')}><Input value={profile.accountHolderName} onChange={(event) => setProfile({ ...profile, accountHolderName: event.target.value })} /></FormField>
    <FormField label={t('finooAffiliates.profile.accountNumber', 'Account number')}><Input value={profile.accountNumber} onChange={(event) => setProfile({ ...profile, accountNumber: event.target.value })} /></FormField>
    <Button type="button" disabled={saving} onClick={() => void save()}>{saving ? t('finooAffiliates.common.saving', 'Saving…') : t('finooAffiliates.common.save', 'Save')}</Button>
  </div>
}
