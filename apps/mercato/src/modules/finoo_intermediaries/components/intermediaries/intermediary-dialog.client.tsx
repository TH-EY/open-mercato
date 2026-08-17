"use client"

import * as React from 'react'
import type { CrudField } from '@open-mercato/ui/backend/CrudForm'
import { CrudForm } from '@open-mercato/ui/backend/CrudForm'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { apiCall, withScopedApiRequestHeaders } from '@open-mercato/ui/backend/utils/apiCall'
import { buildOptimisticLockHeader } from '@open-mercato/ui/backend/utils/optimisticLock'
import { raiseCrudError } from '@open-mercato/ui/backend/utils/serverErrors'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@open-mercato/ui/primitives/dialog'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { intermediaryInviteSchema } from '../../data/validators'
import type { DirectoryMutationResponse, IntermediaryDirectoryItem } from './types'

type IntermediaryFormValues = {
  email: string
  firstName: string
  lastName: string
}

type IntermediaryDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: 'invite' | 'edit'
  row?: IntermediaryDirectoryItem | null
  canInvite: boolean
  onSaved: (item: IntermediaryDirectoryItem) => void
  onReload: () => void
}

export function isIntermediaryEmailDisabled(
  mode: IntermediaryDialogProps['mode'],
  row: IntermediaryDirectoryItem | null | undefined,
  canInvite: boolean,
): boolean {
  return mode === 'edit' && (Boolean(row?.hasLinkedAccount) || !canInvite)
}

export function isIntermediarySubmitShortcut(input: {
  key: string
  metaKey: boolean
  ctrlKey: boolean
}): boolean {
  return input.key === 'Enter' && (input.metaKey || input.ctrlKey)
}

export function IntermediaryDialog({
  open,
  onOpenChange,
  mode,
  row,
  canInvite,
  onSaved,
  onReload,
}: IntermediaryDialogProps) {
  const t = useT()
  const [submitting, setSubmitting] = React.useState(false)
  const fields = React.useMemo<CrudField[]>(() => [
    {
      id: 'email',
      type: 'text',
      label: t('finoo_intermediaries.directory.fields.email'),
      required: true,
      disabled: isIntermediaryEmailDisabled(mode, row, canInvite),
    },
    {
      id: 'firstName',
      type: 'text',
      label: t('finoo_intermediaries.directory.fields.firstName'),
      required: true,
    },
    {
      id: 'lastName',
      type: 'text',
      label: t('finoo_intermediaries.directory.fields.lastName'),
      required: true,
    },
  ], [canInvite, mode, row, t])
  const initialValues = React.useMemo<IntermediaryFormValues>(() => ({
    email: row?.email ?? '',
    firstName: row?.firstName ?? '',
    lastName: row?.lastName ?? '',
  }), [row])

  const handleSubmit = React.useCallback(async (values: IntermediaryFormValues) => {
    setSubmitting(true)
    try {
      const isEdit = mode === 'edit' && row
      const payload = isEdit
        ? {
            firstName: values.firstName,
            lastName: values.lastName,
            ...(!row.hasLinkedAccount && canInvite && values.email !== row.email ? { email: values.email } : {}),
            expectedUpdatedAt: row.updatedAt,
          }
        : values
      const request = () => apiCall<DirectoryMutationResponse>(
        isEdit
          ? `/api/finoo_intermediaries/admin/directory/${row.id}`
          : '/api/finoo_intermediaries/admin/directory/invite',
        {
          method: isEdit ? 'PUT' : 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        },
      )
      const call = isEdit
        ? await withScopedApiRequestHeaders(buildOptimisticLockHeader(row.updatedAt), request)
        : await request()
      if (!call.ok) {
        if (call.status === 502 && call.result?.item) {
          onSaved(call.result.item)
          onReload()
          onOpenChange(false)
          flash(t('finoo_intermediaries.directory.flash.deliveryFailed'), 'error')
          return
        }
        await raiseCrudError(call.response, t('finoo_intermediaries.directory.errors.save'))
      }
      if (!call.result?.item) {
        throw new Error('[internal] Missing intermediary mutation response')
      }
      onSaved(call.result.item)
      onReload()
      onOpenChange(false)
      flash(
        t(isEdit
          ? 'finoo_intermediaries.directory.flash.updated'
          : 'finoo_intermediaries.directory.flash.invited'),
        'success',
      )
      if (call.result.warningCode === 'access_notice_delivery_failed') {
        flash(t('finoo_intermediaries.directory.flash.accessNoticeFailed'), 'warning')
      }
      if (call.result.requiresReactivation) {
        flash(t('finoo_intermediaries.directory.flash.requiresReactivation'), 'warning')
      }
    } finally {
      setSubmitting(false)
    }
  }, [canInvite, mode, onOpenChange, onReload, onSaved, row, t])

  const handleDialogKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!isIntermediarySubmitShortcut(event)) return
    event.preventDefault()
    event.currentTarget.querySelector('form')?.requestSubmit()
  }, [])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl" onKeyDown={handleDialogKeyDown}>
        <DialogHeader>
          <DialogTitle>
            {t(mode === 'edit'
              ? 'finoo_intermediaries.directory.dialog.editTitle'
              : 'finoo_intermediaries.directory.dialog.inviteTitle')}
          </DialogTitle>
        </DialogHeader>
        <CrudForm<IntermediaryFormValues>
          schema={intermediaryInviteSchema}
          fields={fields}
          entityId="finoo_intermediaries:finoo_intermediary"
          initialValues={initialValues}
          optimisticLockUpdatedAt={mode === 'edit' ? row?.updatedAt ?? null : undefined}
          submitLabel={t(mode === 'edit'
            ? 'finoo_intermediaries.directory.actions.save'
            : 'finoo_intermediaries.directory.actions.invite')}
          onSubmit={handleSubmit}
          embedded
          disableInitialFocus={submitting}
          isLoading={submitting}
        />
      </DialogContent>
    </Dialog>
  )
}
