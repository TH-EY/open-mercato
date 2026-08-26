'use client'

import * as React from 'react'
import type { InjectionWidgetComponentProps } from '@open-mercato/shared/modules/widgets/injection'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { ErrorMessage, LoadingMessage } from '@open-mercato/ui/backend/detail'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { StatusBadge, type StatusBadgeVariant } from '@open-mercato/ui/primitives/status-badge'
import type { IdentityFieldStatus, IdentityFieldStatuses } from '../../../lib/identity-domain'
import {
  identityStatusStateKey,
  readIdentityStatusSharedState,
} from '../identity-status-sync'

const fields: Array<keyof IdentityFieldStatuses> = [
  'pesel',
  'documentType',
  'issuingCountryCode',
  'documentNumber',
  'issuedOn',
  'expiresOn',
]

function readStatuses(data: unknown): IdentityFieldStatuses | null {
  if (!data || typeof data !== 'object') return null
  const payload = data as Record<string, unknown>
  const person = payload.person && typeof payload.person === 'object'
    ? payload.person as Record<string, unknown>
    : payload
  const enrichment = person._finooIdentities && typeof person._finooIdentities === 'object'
    ? person._finooIdentities as Record<string, unknown>
    : null
  const statuses = enrichment?.statuses
  if (!statuses || typeof statuses !== 'object') return null
  return statuses as IdentityFieldStatuses
}

function readPersonId(context: unknown, data: unknown): string | null {
  if (context && typeof context === 'object') {
    const candidate = context as Record<string, unknown>
    if (typeof candidate.personId === 'string') return candidate.personId
    if (typeof candidate.resourceId === 'string') return candidate.resourceId
  }
  if (!data || typeof data !== 'object') return null
  const payload = data as Record<string, unknown>
  const person = payload.person && typeof payload.person === 'object'
    ? payload.person as Record<string, unknown>
    : payload
  return typeof person.id === 'string' ? person.id : null
}

function statusVariant(status: IdentityFieldStatus): StatusBadgeVariant {
  if (status === 'complete') return 'success'
  if (status === 'not_applicable') return 'info'
  return 'warning'
}

export default function CompletenessDetailWidget({ context, data }: InjectionWidgetComponentProps) {
  const t = useT()
  const embeddedStatuses = readStatuses(data)
  const personId = readPersonId(context, data)
  const sharedState = readIdentityStatusSharedState(context)
  const publicationRevision = React.useRef(0)
  const [statuses, setStatuses] = React.useState<IdentityFieldStatuses | null>(embeddedStatuses)
  const [loading, setLoading] = React.useState(!embeddedStatuses)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!personId || !sharedState?.subscribe) return
    return sharedState.subscribe(identityStatusStateKey(personId), (value) => {
      if (value && typeof value === 'object') {
        publicationRevision.current += 1
        setStatuses(value as IdentityFieldStatuses)
        setLoading(false)
        setError(null)
      }
    })
  }, [personId, sharedState])

  React.useEffect(() => {
    if (!personId) {
      setLoading(false)
      setError(t('finoo_identities.errors.invalidPerson'))
      return
    }
    let cancelled = false
    const revisionAtRequest = publicationRevision.current
    setStatuses(embeddedStatuses)
    setLoading(!embeddedStatuses)
    setError(null)
    void readApiResultOrThrow<{ statuses: IdentityFieldStatuses }>(
      `/api/finoo_identities/people/${encodeURIComponent(personId)}/status`,
      { cache: 'no-store' },
      { errorMessage: t('finoo_identities.errors.loadStatus') },
    ).then((result) => {
      if (!cancelled && publicationRevision.current === revisionAtRequest) setStatuses(result.statuses)
    }).catch((caught) => {
      if (!cancelled && publicationRevision.current === revisionAtRequest) {
        setError(caught instanceof Error ? caught.message : t('finoo_identities.errors.loadStatus'))
      }
    }).finally(() => {
      if (!cancelled && publicationRevision.current === revisionAtRequest) setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [embeddedStatuses, personId, t])

  if (loading) return <LoadingMessage label={t('finoo_identities.identity.loadingStatus')} />
  if (error) return <ErrorMessage label={error} />
  if (!statuses) return null
  return (
    <section className="space-y-3 border-t border-border pt-4" aria-label={t('finoo_identities.identity.title')}>
      <h3 className="text-sm font-semibold text-foreground">{t('finoo_identities.identity.title')}</h3>
      <div className="grid gap-2 sm:grid-cols-2">
        {fields.map((field) => {
          const status = statuses[field] ?? 'missing'
          return (
            <div key={field} className="flex items-center justify-between gap-3 border-b border-border py-2">
              <span className="text-sm text-muted-foreground">{t(`finoo_identities.fields.${field}`)}</span>
              <StatusBadge variant={statusVariant(status)} dot>
                {t(`finoo_identities.status.${status}`)}
              </StatusBadge>
            </div>
          )
        })}
      </div>
    </section>
  )
}
