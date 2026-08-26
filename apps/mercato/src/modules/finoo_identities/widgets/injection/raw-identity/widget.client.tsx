'use client'

import * as React from 'react'
import type { InjectionWidgetComponentProps } from '@open-mercato/shared/modules/widgets/injection'
import { hasFeature } from '@open-mercato/shared/security/features'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { CrudForm, type CrudField } from '@open-mercato/ui/backend/CrudForm'
import { ErrorMessage, LoadingMessage } from '@open-mercato/ui/backend/detail'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useBackendChrome } from '@open-mercato/ui/backend/BackendChromeProvider'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import { apiCallOrThrow, readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { Button } from '@open-mercato/ui/primitives/button'
import { finooIdentityFormSchema, type FinooIdentityInput } from '../../../data/validators'
import { IDENTITY_DOCUMENT_TYPES, type IdentityFieldStatuses } from '../../../lib/identity-domain'
import { publishIdentityStatuses } from '../identity-status-sync'

type RawIdentityView = FinooIdentityInput & {
  id: string
  isComplete: boolean
  statuses: IdentityFieldStatuses
  updatedAt: string
}

type IdentityWriteResult = Pick<RawIdentityView, 'id' | 'isComplete' | 'statuses' | 'updatedAt'>

type IdentityConflict = {
  id: string
  changedFields: string[]
  current: FinooIdentityInput & { updatedAt: string }
  candidate: FinooIdentityInput
  updatedAt: string
}

type ConflictResolutionResult = {
  conflictId: string
  identityId: string
  state: 'resolved' | 'dismissed'
  isComplete: boolean
  statuses: IdentityFieldStatuses
  identityUpdatedAt: string
}

type WidgetContext = Record<string, unknown> & {
  personId?: string | null
  resourceId?: string | null
}

const EMPTY_VALUES: FinooIdentityInput = {
  pesel: '',
  documentType: null,
  issuingCountryCode: null,
  documentNumber: null,
  issuedOn: null,
  expiresOn: null,
}

function resolvePersonId(context: WidgetContext, data: unknown): string | null {
  if (typeof context.personId === 'string' && context.personId.length > 0) return context.personId
  if (typeof context.resourceId === 'string' && context.resourceId.length > 0) return context.resourceId
  if (!data || typeof data !== 'object') return null
  const person = (data as Record<string, unknown>).person
  if (!person || typeof person !== 'object') return null
  const id = (person as Record<string, unknown>).id
  return typeof id === 'string' && id.length > 0 ? id : null
}

export default function RawIdentityWidget({ context, data }: InjectionWidgetComponentProps) {
  const t = useT()
  const { payload } = useBackendChrome()
  const canManage = hasFeature(payload?.grantedFeatures ?? [], 'finoo_identities.manage')
  const widgetContext = context && typeof context === 'object'
    ? context as WidgetContext
    : {}
  const personId = resolvePersonId(widgetContext, data)
  const [identity, setIdentity] = React.useState<RawIdentityView | null>(null)
  const [missing, setMissing] = React.useState(false)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [formVersion, setFormVersion] = React.useState(0)
  const [conflicts, setConflicts] = React.useState<IdentityConflict[]>([])
  const [conflictsLoading, setConflictsLoading] = React.useState(false)
  const [conflictsError, setConflictsError] = React.useState<string | null>(null)
  const [resolvingConflictId, setResolvingConflictId] = React.useState<string | null>(null)
  const mutationContextId = `finoo-identity-conflict:${personId ?? 'pending'}`
  const { runMutation, retryLastMutation } = useGuardedMutation<{
    formId: string
    resourceKind: string
    resourceId: string
    retryLastMutation: () => Promise<boolean>
  }>({
    contextId: mutationContextId,
    blockedMessage: t('finoo_identities.errors.save'),
  })

  React.useEffect(() => {
    let cancelled = false
    async function load() {
      if (!personId) {
        setError(t('finoo_identities.errors.invalidPerson'))
        setLoading(false)
        return
      }
      setLoading(true)
      setError(null)
      setMissing(false)
      try {
        const result = await readApiResultOrThrow<RawIdentityView>(
          `/api/finoo_identities/people/${encodeURIComponent(personId)}`,
          { cache: 'no-store' },
          { errorMessage: t('finoo_identities.errors.load') },
        )
        if (!cancelled) setIdentity(result)
      } catch (caught) {
        if (cancelled) return
        if ((caught as { status?: number }).status === 404) {
          setIdentity(null)
          setMissing(true)
        } else {
          setError(caught instanceof Error ? caught.message : t('finoo_identities.errors.load'))
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [personId, t])

  React.useEffect(() => {
    let cancelled = false
    async function loadConflicts() {
      if (!personId) return
      setConflictsLoading(true)
      setConflictsError(null)
      try {
        const result = await readApiResultOrThrow<{ items: IdentityConflict[] }>(
          `/api/finoo_identities/import-conflicts?personId=${encodeURIComponent(personId)}&page=1&pageSize=50`,
          { cache: 'no-store' },
          { errorMessage: t('finoo_identities.conflicts.loadError') },
        )
        if (!cancelled) setConflicts(result.items)
      } catch (caught) {
        if (cancelled) return
        if ((caught as { status?: number }).status === 404) {
          setConflicts([])
        } else {
          setConflictsError(caught instanceof Error
            ? caught.message
            : t('finoo_identities.conflicts.loadError'))
        }
      } finally {
        if (!cancelled) setConflictsLoading(false)
      }
    }
    void loadConflicts()
    return () => {
      cancelled = true
    }
  }, [personId, t])

  const fields = React.useMemo<CrudField[]>(() => [
    {
      id: 'pesel',
      label: t('finoo_identities.fields.pesel'),
      type: 'text',
      required: true,
      maxLength: 11,
      readOnly: !canManage,
    },
    {
      id: 'documentType',
      label: t('finoo_identities.fields.documentType'),
      type: 'select',
      options: Object.keys(IDENTITY_DOCUMENT_TYPES).map((value) => ({
        value,
        label: t(`finoo_identities.documentTypes.${value}`),
      })),
      disabled: !canManage,
    },
    {
      id: 'issuingCountryCode',
      label: t('finoo_identities.fields.issuingCountryCode'),
      type: 'text',
      maxLength: 2,
      readOnly: !canManage,
      visibleWhen: { field: 'documentType', equals: 'passport' },
    },
    {
      id: 'documentNumber',
      label: t('finoo_identities.fields.documentNumber'),
      type: 'text',
      maxLength: 64,
      readOnly: !canManage,
    },
    {
      id: 'issuedOn',
      label: t('finoo_identities.fields.issuedOn'),
      type: 'date',
      readOnly: !canManage,
    },
    {
      id: 'expiresOn',
      label: t('finoo_identities.fields.expiresOn'),
      type: 'date',
      readOnly: !canManage,
    },
  ], [canManage, t])

  const resolveConflict = React.useCallback(async (
    conflict: IdentityConflict,
    action: 'replace' | 'dismiss',
  ) => {
    setResolvingConflictId(conflict.id)
    try {
      const call = await runMutation({
        operation: () => apiCallOrThrow<ConflictResolutionResult>(
          `/api/finoo_identities/import-conflicts/${encodeURIComponent(conflict.id)}/resolve`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              action,
              updatedAt: conflict.updatedAt,
              identityUpdatedAt: conflict.current.updatedAt,
            }),
          },
          { errorMessage: t('finoo_identities.conflicts.resolveError') },
        ),
        context: {
          formId: mutationContextId,
          resourceKind: 'finoo_identities.import_conflict',
          resourceId: conflict.id,
          retryLastMutation,
        },
        mutationPayload: { action },
      })
      if (!call.result) throw new Error('[internal] Missing conflict resolution response')
      if (action === 'replace') {
        setIdentity((current) => current
          ? {
              ...current,
              ...conflict.candidate,
              id: call.result?.identityId ?? current.id,
              isComplete: call.result?.isComplete ?? current.isComplete,
              statuses: call.result?.statuses ?? current.statuses,
              updatedAt: call.result?.identityUpdatedAt ?? current.updatedAt,
            }
          : current)
        setFormVersion((current) => current + 1)
        if (call.result?.statuses && personId) {
          publishIdentityStatuses(context, personId, call.result.statuses)
        }
      }
      setConflicts((current) => current.filter((item) => item.id !== conflict.id))
      flash(t(action === 'replace'
        ? 'finoo_identities.conflicts.resolved'
        : 'finoo_identities.conflicts.dismissed'), 'success')
    } catch {
      flash(t('finoo_identities.conflicts.resolveError'), 'error')
    } finally {
      setResolvingConflictId(null)
    }
  }, [context, mutationContextId, personId, retryLastMutation, runMutation, t])

  if (loading) return <LoadingMessage label={t('finoo_identities.raw.loading')} />
  if (error) return <ErrorMessage label={error} />
  if (!personId) return null
  if (missing && !canManage) {
    return <p className="text-sm text-muted-foreground">{t('finoo_identities.raw.empty')}</p>
  }

  const initialValues: FinooIdentityInput = identity
    ? {
        pesel: identity.pesel,
        documentType: identity.documentType,
        issuingCountryCode: identity.issuingCountryCode,
        documentNumber: identity.documentNumber,
        issuedOn: identity.issuedOn,
        expiresOn: identity.expiresOn,
      }
    : EMPTY_VALUES

  return (
    <section
      className="space-y-3 border-t border-border pt-4"
      aria-label={t('finoo_identities.raw.title')}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !canManage) return
        event.preventDefault()
        setFormVersion((current) => current + 1)
      }}
    >
      <h3 className="text-sm font-semibold text-foreground">{t('finoo_identities.raw.title')}</h3>
      <CrudForm<FinooIdentityInput>
        key={`${identity?.updatedAt ?? 'missing'}:${formVersion}`}
        schema={finooIdentityFormSchema}
        fields={fields}
        initialValues={initialValues}
        optimisticLockUpdatedAt={identity?.updatedAt ?? null}
        submitLabel={t(identity ? 'finoo_identities.raw.save' : 'finoo_identities.raw.create')}
        embedded
        readOnly={!canManage}
        onSubmit={async (values) => {
          const call = await apiCallOrThrow<IdentityWriteResult>(
            `/api/finoo_identities/people/${encodeURIComponent(personId)}`,
            {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(values),
            },
            { errorMessage: t('finoo_identities.errors.save') },
          )
          if (!call.result) throw new Error('[internal] Missing identity write response')
          setIdentity({ ...values, ...call.result })
          setMissing(false)
          publishIdentityStatuses(context, personId, call.result.statuses)
        }}
      />
      {conflictsLoading ? <LoadingMessage label={t('finoo_identities.conflicts.loading')} /> : null}
      {conflictsError ? <ErrorMessage label={conflictsError} /> : null}
      {conflicts.length > 0 ? (
        <div className="space-y-4 border-t border-border pt-4">
          <h4 className="text-sm font-semibold text-foreground">{t('finoo_identities.conflicts.title')}</h4>
          {conflicts.map((conflict) => (
            <div key={conflict.id} className="space-y-3 border-b border-border pb-4">
              <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]">
                <dt className="text-xs font-medium text-muted-foreground">
                  {t('finoo_identities.conflicts.field')}
                </dt>
                <dd className="text-xs font-medium text-muted-foreground">
                  {t('finoo_identities.conflicts.current')}
                </dd>
                <dd className="text-xs font-medium text-muted-foreground">
                  {t('finoo_identities.conflicts.candidate')}
                </dd>
                {conflict.changedFields.map((field) => {
                  const identityField = field as keyof FinooIdentityInput
                  return (
                    <React.Fragment key={field}>
                      <dt className="text-sm">{t(`finoo_identities.fields.${field}`)}</dt>
                      <dd className="break-all text-sm">
                        {String(conflict.current[identityField] ?? t('finoo_identities.raw.emptyValue'))}
                      </dd>
                      <dd className="break-all text-sm">
                        {String(conflict.candidate[identityField] ?? t('finoo_identities.raw.emptyValue'))}
                      </dd>
                    </React.Fragment>
                  )
                })}
              </dl>
              {canManage ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    disabled={resolvingConflictId !== null}
                    onClick={() => void resolveConflict(conflict, 'replace')}
                  >
                    {t('finoo_identities.conflicts.replace')}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={resolvingConflictId !== null}
                    onClick={() => void resolveConflict(conflict, 'dismiss')}
                  >
                    {t('finoo_identities.conflicts.dismiss')}
                  </Button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  )
}
