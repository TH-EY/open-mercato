"use client"

import * as React from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { useOrganizationScopeVersion } from '@open-mercato/shared/lib/frontend/useOrganizationScope'
import { Alert } from '@open-mercato/ui/primitives/alert'
import { Button } from '@open-mercato/ui/primitives/button'
import { FormField } from '@open-mercato/ui/primitives/form-field'
import { Input } from '@open-mercato/ui/primitives/input'
import { Label } from '@open-mercato/ui/primitives/label'
import { Switch } from '@open-mercato/ui/primitives/switch'
import { ErrorMessage, LoadingMessage } from '@open-mercato/ui/backend/detail'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useConfirmDialog } from '@open-mercato/ui/backend/confirm-dialog'
import { surfaceRecordConflict } from '@open-mercato/ui/backend/conflicts'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import {
  readApiResultOrThrow,
  withScopedApiRequestHeaders,
} from '@open-mercato/ui/backend/utils/apiCall'
import { buildOptimisticLockHeader } from '@open-mercato/ui/backend/utils/optimisticLock'

type RetentionSetting = {
  inactivityWindowDays: number | null
  updatedAt: string | null
}

type SettingsResponse = Partial<RetentionSetting> & {
  setting?: Partial<RetentionSetting> | null
}

type PreviewResponse = {
  token?: string
  previewToken?: string
  expiresAt: string
  totalEligible: number
  newlyExpired: number
  alreadyExpired: number
  updatedAt: string
}

type SaveResponse = SettingsResponse & {
  progressJobId?: string | null
}

type SaveOutcome = 'saved' | 'preview_stale' | 'failed'

const MIN_WINDOW_DAYS = 1
const MAX_WINDOW_DAYS = 3650

function normalizeSetting(response: SettingsResponse): RetentionSetting {
  const setting = response.setting ?? response
  return {
    inactivityWindowDays: typeof setting.inactivityWindowDays === 'number'
      ? setting.inactivityWindowDays
      : null,
    updatedAt: typeof setting.updatedAt === 'string'
      ? setting.updatedAt
      : typeof response.updatedAt === 'string'
        ? response.updatedAt
        : null,
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  if (!error || typeof error !== 'object') return false
  const candidate = error as Record<string, unknown>
  return candidate.status === 409 && candidate.code === code
}

export default function RetentionSettingsClient(): React.ReactElement {
  const t = useT()
  const scopeVersion = useOrganizationScopeVersion()
  const { confirm, ConfirmDialogElement } = useConfirmDialog()
  const [setting, setSetting] = React.useState<RetentionSetting | null>(null)
  const [enabled, setEnabled] = React.useState(false)
  const [windowDays, setWindowDays] = React.useState('365')
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [loadError, setLoadError] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [progressJobId, setProgressJobId] = React.useState<string | null>(null)
  const submitInFlightRef = React.useRef(false)
  const { runMutation, retryLastMutation } = useGuardedMutation({
    contextId: 'finoo-customer-retention.settings',
    blockedMessage: t(
      'finooCustomerRetention.settings.errors.blocked',
      'The retention setting change was blocked.',
    ),
  })

  const load = React.useCallback(async () => {
    setLoading(true)
    setLoadError(false)
    setError(null)
    try {
      const response = await readApiResultOrThrow<SettingsResponse>(
        '/api/finoo_customer_retention/settings',
        undefined,
        {
          errorMessage: t(
            'finooCustomerRetention.settings.errors.load',
            'Unable to load customer retention settings.',
          ),
        },
      )
      const nextSetting = normalizeSetting(response)
      setSetting(nextSetting)
      setEnabled(nextSetting.inactivityWindowDays !== null)
      if (nextSetting.inactivityWindowDays !== null) {
        setWindowDays(String(nextSetting.inactivityWindowDays))
      }
    } catch {
      setLoadError(true)
    } finally {
      setLoading(false)
    }
  }, [t])

  React.useEffect(() => {
    void load()
  }, [load, scopeVersion])

  const parsedWindowDays = Number(windowDays)
  const windowIsValid = Number.isInteger(parsedWindowDays)
    && parsedWindowDays >= MIN_WINDOW_DAYS
    && parsedWindowDays <= MAX_WINDOW_DAYS
  const nextWindowDays = enabled && windowIsValid ? parsedWindowDays : null
  const changed = setting !== null && nextWindowDays !== setting.inactivityWindowDays
  const currentWindowDays = setting?.inactivityWindowDays
  const requiresPreview = nextWindowDays !== null
    && (currentWindowDays === null
      || (typeof currentWindowDays === 'number' && nextWindowDays < currentWindowDays))
  const validationError = enabled && !windowIsValid
    ? t(
        'finooCustomerRetention.settings.errors.windowRange',
        'Enter a whole number from 1 to 3650.',
      )
    : undefined

  const requestPreview = React.useCallback(async (
    inactivityWindowDays: number,
    expectedUpdatedAt: string | null,
  ) => {
    const preview = await runMutation({
      context: { retryLastMutation },
      mutationPayload: { inactivityWindowDays, operation: 'preview' },
      operation: () => withScopedApiRequestHeaders(
        buildOptimisticLockHeader(expectedUpdatedAt),
        () => readApiResultOrThrow<PreviewResponse>(
          '/api/finoo_customer_retention/settings/preview',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ inactivityWindowDays }),
          },
          {
            errorMessage: t(
              'finooCustomerRetention.settings.errors.preview',
              'Unable to prepare the retention impact preview.',
            ),
          },
        ),
      ),
    })
    setSetting((current) => current ? { ...current, updatedAt: preview.updatedAt } : current)
    return preview
  }, [retryLastMutation, runMutation, t])

  const confirmPreview = React.useCallback(async (preview: PreviewResponse) => {
    const previewToken = preview.token ?? preview.previewToken
    if (!previewToken) {
      throw new Error('[internal] Retention preview did not return a token')
    }
    const accepted = await confirm({
      title: t(
        'finooCustomerRetention.settings.preview.title',
        'Confirm retention period change',
      ),
      text: t(
        'finooCustomerRetention.settings.preview.description',
        'Eligible people: {totalEligible}. Newly expired: {newlyExpired}. Already expired: {alreadyExpired}.',
        {
          totalEligible: preview.totalEligible,
          newlyExpired: preview.newlyExpired,
          alreadyExpired: preview.alreadyExpired,
        },
      ),
      confirmText: t(
        'finooCustomerRetention.settings.preview.confirm',
        'Apply retention period',
      ),
      variant: 'destructive',
    })
    return accepted ? previewToken : null
  }, [confirm, t])

  const readCurrentSetting = React.useCallback(async () => {
    const response = await readApiResultOrThrow<SettingsResponse>(
      '/api/finoo_customer_retention/settings',
      undefined,
      {
        errorMessage: t(
          'finooCustomerRetention.settings.errors.load',
          'Unable to load customer retention settings.',
        ),
      },
    )
    return normalizeSetting(response)
  }, [t])

  const save = React.useCallback(async (
    desiredWindowDays: number | null,
    previewToken?: string,
    expectedUpdatedAt?: string | null,
  ): Promise<SaveOutcome> => {
    if (!setting || submitInFlightRef.current || (enabled && !windowIsValid)) return 'failed'
    submitInFlightRef.current = true
    setSaving(true)
    setError(null)
    try {
      const response = await runMutation({
        context: { retryLastMutation },
        mutationPayload: { inactivityWindowDays: desiredWindowDays },
        operation: () => withScopedApiRequestHeaders(
          buildOptimisticLockHeader(expectedUpdatedAt ?? setting.updatedAt),
          () => readApiResultOrThrow<SaveResponse>(
            '/api/finoo_customer_retention/settings',
            {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                inactivityWindowDays: desiredWindowDays,
                ...(previewToken ? { previewToken } : {}),
              }),
            },
            {
              errorMessage: t(
                'finooCustomerRetention.settings.errors.save',
                'Unable to save customer retention settings.',
              ),
            },
          ),
        ),
      })
      const nextSetting = normalizeSetting(response)
      setSetting(nextSetting)
      setEnabled(nextSetting.inactivityWindowDays !== null)
      if (nextSetting.inactivityWindowDays !== null) {
        setWindowDays(String(nextSetting.inactivityWindowDays))
      }
      const nextProgressJobId = response.progressJobId ?? null
      setProgressJobId(nextProgressJobId)
      flash(
        nextProgressJobId
          ? t(
              'finooCustomerRetention.settings.flash.queued',
              'Retention settings were saved. Reconciliation progress is visible in the top bar.',
            )
          : t('finooCustomerRetention.settings.flash.saved', 'Retention settings were saved.'),
        'success',
      )
      return 'saved'
    } catch (caught) {
      if (hasErrorCode(caught, 'preview_stale')) return 'preview_stale'
      if (!surfaceRecordConflict(caught, t, { onRefresh: load })) {
        const message = t(
          'finooCustomerRetention.settings.errors.save',
          'Unable to save customer retention settings.',
        )
        setError(message)
        flash(message, 'error')
      }
      return 'failed'
    } finally {
      submitInFlightRef.current = false
      setSaving(false)
    }
  }, [enabled, load, retryLastMutation, runMutation, setting, t, windowIsValid])

  const refreshStalePreviewOnce = React.useCallback(async (desiredWindowDays: number) => {
    try {
      const freshSetting = await readCurrentSetting()
      setSetting(freshSetting)
      const preview = await requestPreview(desiredWindowDays, freshSetting.updatedAt)
      const previewToken = await confirmPreview(preview)
      if (!previewToken) return

      const outcome = await save(desiredWindowDays, previewToken, preview.updatedAt)
      if (outcome !== 'preview_stale') return

      const message = t(
        'finooCustomerRetention.settings.errors.previewStale',
        'The retention preview changed again. Review the latest data and try once more.',
      )
      setError(message)
      flash(message, 'error')
    } catch (caught) {
      if (!surfaceRecordConflict(caught, t, { onRefresh: load })) {
        const message = t(
          'finooCustomerRetention.settings.errors.preview',
          'Unable to prepare the retention impact preview.',
        )
        setError(message)
        flash(message, 'error')
      }
    }
  }, [confirmPreview, load, readCurrentSetting, requestPreview, save, t])

  const submit = React.useCallback(async () => {
    if (!setting || submitInFlightRef.current || !changed || (enabled && !windowIsValid)) return
    if (!requiresPreview || nextWindowDays === null) {
      await save(nextWindowDays)
      return
    }

    submitInFlightRef.current = true
    setSaving(true)
    setError(null)
    try {
      const preview = await requestPreview(nextWindowDays, setting.updatedAt)
      const previewToken = await confirmPreview(preview)
      if (!previewToken) return

      submitInFlightRef.current = false
      setSaving(false)
      const outcome = await save(nextWindowDays, previewToken, preview.updatedAt)
      if (outcome === 'preview_stale') {
        await refreshStalePreviewOnce(nextWindowDays)
      }
    } catch (caught) {
      if (!surfaceRecordConflict(caught, t, { onRefresh: load })) {
        const message = t(
          'finooCustomerRetention.settings.errors.preview',
          'Unable to prepare the retention impact preview.',
        )
        setError(message)
        flash(message, 'error')
      }
    } finally {
      submitInFlightRef.current = false
      setSaving(false)
    }
  }, [changed, confirmPreview, enabled, load, nextWindowDays, refreshStalePreviewOnce, requestPreview, requiresPreview, save, setting, t, windowIsValid])

  if (loading) {
    return <LoadingMessage label={t('finooCustomerRetention.settings.loading', 'Loading retention settings…')} />
  }

  if (loadError || !setting) {
    return (
      <ErrorMessage
        label={t(
          'finooCustomerRetention.settings.errors.load',
          'Unable to load customer retention settings.',
        )}
        action={(
          <Button type="button" variant="outline" size="sm" onClick={() => void load()}>
            {t('common.retry', 'Retry')}
          </Button>
        )}
      />
    )
  }

  return (
    <form
      className="max-w-2xl space-y-6"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
          event.preventDefault()
          void submit()
        }
      }}
    >
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          {t('finooCustomerRetention.settings.title', 'Customer data retention')}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t(
            'finooCustomerRetention.settings.description',
            'Expire eligible people after a period without qualifying activity.',
          )}
        </p>
      </div>

      {error ? <Alert status="error" style="lighter">{error}</Alert> : null}
      {progressJobId ? (
        <Alert status="information" style="lighter">
          {t(
            'finooCustomerRetention.settings.progress',
            'Reconciliation has started. Progress is visible in the top bar.',
          )}
        </Alert>
      ) : null}

      <div className="space-y-5 border-y border-border py-5">
        <div className="flex items-start justify-between gap-6">
          <div className="space-y-1">
            <Label htmlFor="finoo-retention-enabled">
              {t('finooCustomerRetention.settings.enabled.label', 'Enable retention expiry')}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t(
                'finooCustomerRetention.settings.enabled.description',
                'Disabling the rule does not reactivate people who are already expired.',
              )}
            </p>
          </div>
          <Switch
            id="finoo-retention-enabled"
            checked={enabled}
            onCheckedChange={setEnabled}
            disabled={saving}
            aria-label={t('finooCustomerRetention.settings.enabled.label', 'Enable retention expiry')}
          />
        </div>

        <FormField
          id="finoo-retention-window-days"
          label={t('finooCustomerRetention.settings.window.label', 'Inactivity period in days')}
          description={t(
            'finooCustomerRetention.settings.window.description',
            'Use a whole number from 1 to 3650. Each day is an exact 24-hour period.',
          )}
          error={validationError}
          required={enabled}
          disabled={!enabled || saving}
        >
          <Input
            type="number"
            min={MIN_WINDOW_DAYS}
            max={MAX_WINDOW_DAYS}
            step={1}
            value={windowDays}
            onChange={(event) => setWindowDays(event.target.value)}
          />
        </FormField>
      </div>

      <div className="flex justify-end border-t border-border pt-4">
        <Button type="submit" disabled={saving || !changed || (enabled && !windowIsValid)}>
          {saving
            ? t('finooCustomerRetention.settings.saving', 'Saving…')
            : t('common.save', 'Save')}
        </Button>
      </div>
      {ConfirmDialogElement}
    </form>
  )
}
