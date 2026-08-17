"use client"

import * as React from 'react'
import type { RowActionItem } from '@open-mercato/ui/backend/RowActions'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useConfirmDialog } from '@open-mercato/ui/backend/confirm-dialog'
import { surfaceRecordConflict } from '@open-mercato/ui/backend/conflicts'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import { apiCall, withScopedApiRequestHeaders } from '@open-mercato/ui/backend/utils/apiCall'
import { buildOptimisticLockHeader } from '@open-mercato/ui/backend/utils/optimisticLock'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import type { DirectoryMutationResponse, IntermediaryDirectoryItem } from './types'

type LifecycleAction = 'resend' | 'cancel-invitation' | 'deactivate' | 'reactivate'

type LifecycleActionsOptions = {
  canManage: boolean
  canInvite: boolean
  canManageAccounts: boolean
  onEdit: (row: IntermediaryDirectoryItem) => void
  onSaved: (item: IntermediaryDirectoryItem) => void
  onReload: () => void
}

type RowActionPermissions = Pick<LifecycleActionsOptions, 'canManage' | 'canInvite' | 'canManageAccounts'>

export function resolveIntermediaryActionIds(
  row: IntermediaryDirectoryItem,
  permissions: RowActionPermissions,
): string[] {
  if (!permissions.canManage) return []
  if (row.status === 'invited' || row.status === 'expired') {
    return permissions.canInvite ? ['edit', 'resend', 'cancel-invitation'] : ['edit']
  }
  if (row.status === 'delivery_failed') {
    return permissions.canInvite ? ['edit', 'retry', 'cancel-invitation'] : ['edit']
  }
  if (row.status === 'active') {
    return permissions.canManageAccounts ? ['edit', 'deactivate'] : ['edit']
  }
  if (row.status === 'inactive') {
    const canReactivate = permissions.canManageAccounts && (row.hasLinkedAccount || permissions.canInvite)
    return canReactivate ? ['edit', 'reactivate'] : ['edit']
  }
  return ['edit']
}

export function useIntermediaryRowActions({
  canManage,
  canInvite,
  canManageAccounts,
  onEdit,
  onSaved,
  onReload,
}: LifecycleActionsOptions) {
  const t = useT()
  const { confirm, ConfirmDialogElement } = useConfirmDialog()
  const contextId = 'finoo-intermediaries:directory-actions'
  const { runMutation, retryLastMutation } = useGuardedMutation<Record<string, unknown>>({
    contextId,
    blockedMessage: t('finoo_intermediaries.directory.errors.blocked'),
  })

  const executeAction = React.useCallback(async (
    row: IntermediaryDirectoryItem,
    action: LifecycleAction,
  ) => {
    if (action === 'cancel-invitation') {
      const confirmed = await confirm({
        title: t('finoo_intermediaries.directory.confirm.cancelTitle'),
        text: t('finoo_intermediaries.directory.confirm.cancelText'),
        variant: 'destructive',
      })
      if (!confirmed) return
    }
    if (action === 'deactivate') {
      const confirmed = await confirm({
        title: t('finoo_intermediaries.directory.confirm.deactivateTitle'),
        text: t('finoo_intermediaries.directory.confirm.deactivateText', { count: row.relatedDeals }),
        variant: 'destructive',
      })
      if (!confirmed) return
    }
    if (action === 'reactivate') {
      const confirmed = await confirm({
        title: t('finoo_intermediaries.directory.confirm.reactivateTitle'),
        text: t(row.hasLinkedAccount
          ? 'finoo_intermediaries.directory.confirm.reactivateLinkedText'
          : 'finoo_intermediaries.directory.confirm.reactivateUnlinkedText'),
      })
      if (!confirmed) return
    }

    try {
      let deliveryFailed = false
      await runMutation({
        operation: async () => {
          const call = await withScopedApiRequestHeaders(
            buildOptimisticLockHeader(row.updatedAt),
            () => apiCall<DirectoryMutationResponse>(
              `/api/finoo_intermediaries/admin/directory/${row.id}/${action}`,
              {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ expectedUpdatedAt: row.updatedAt }),
              },
            ),
          )
          if (!call.ok) {
            if (call.status === 502 && call.result?.item) {
              deliveryFailed = true
              onSaved(call.result.item)
              flash(t('finoo_intermediaries.directory.flash.deliveryFailed'), 'error')
              return call
            }
            throw Object.assign(new Error('[internal] Intermediary lifecycle action failed'), {
              status: call.status,
              ...((call.result as Record<string, unknown> | null) ?? {}),
            })
          }
          if (call.result?.item) {
            onSaved(call.result.item)
            onReload()
          }
          if (call.result?.warningCode === 'access_notice_delivery_failed') {
            flash(t('finoo_intermediaries.directory.flash.accessNoticeFailed'), 'warning')
          }
          return call
        },
        context: {
          formId: contextId,
          resourceKind: 'finoo_intermediaries.intermediary',
          resourceId: row.id,
          retryLastMutation,
        },
        mutationPayload: { id: row.id, action, expectedUpdatedAt: row.updatedAt },
      })
      if (deliveryFailed) return
      flash(t(`finoo_intermediaries.directory.flash.${action === 'cancel-invitation' ? 'cancelled' : action}`), 'success')
    } catch (error) {
      if (surfaceRecordConflict(error, t, { onRefresh: onReload })) return
      flash(t('finoo_intermediaries.directory.errors.action'), 'error')
    }
  }, [confirm, contextId, onReload, onSaved, retryLastMutation, runMutation, t])

  const getRowActions = React.useCallback((row: IntermediaryDirectoryItem): RowActionItem[] => {
    return resolveIntermediaryActionIds(row, { canManage, canInvite, canManageAccounts }).map((id) => {
      if (id === 'edit') return {
        id,
        label: t('finoo_intermediaries.directory.actions.edit'),
        onSelect: () => onEdit(row),
      }
      if (id === 'resend') return {
        id: 'resend',
        label: t('finoo_intermediaries.directory.actions.resend'),
        onSelect: () => { void executeAction(row, 'resend') },
      }
      if (id === 'retry') return {
        id: 'retry',
        label: t('finoo_intermediaries.directory.actions.retry'),
        onSelect: () => { void executeAction(row, 'resend') },
      }
      if (id === 'cancel-invitation') return {
        id: 'cancel-invitation',
        label: t('finoo_intermediaries.directory.actions.cancelInvitation'),
        destructive: true,
        onSelect: () => { void executeAction(row, 'cancel-invitation') },
      }
      if (id === 'deactivate') return {
        id: 'deactivate',
        label: t('finoo_intermediaries.directory.actions.deactivate'),
        destructive: true,
        onSelect: () => { void executeAction(row, 'deactivate') },
      }
      return {
        id: 'reactivate',
        label: t('finoo_intermediaries.directory.actions.reactivate'),
        onSelect: () => { void executeAction(row, 'reactivate') },
      }
    })
  }, [canInvite, canManage, canManageAccounts, executeAction, onEdit, t])

  return { getRowActions, ConfirmDialogElement }
}
