"use client"

import * as React from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { Button } from '@open-mercato/ui/primitives/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@open-mercato/ui/primitives/dialog'
import { EmailInput } from '@open-mercato/ui/primitives/email-input'
import { Label } from '@open-mercato/ui/primitives/label'

type CoreInviteResponse = {
  ok: true
  invitation: { id: string; email: string }
}

type EnsureInvitationResponse = {
  ok: true
  affiliate: {
    id: string
    code: string
    isActive: boolean
    trackedUrl: string
  }
}

type InviteMutationContext = {
  resourceKind: string
  resourceId?: string
  retryLastMutation: () => Promise<boolean>
}

export default function InviteAffiliateDialog({
  open,
  onOpenChange,
  affiliateRoleId,
  defaultDestinationReady,
  onSynchronized,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  affiliateRoleId: string
  defaultDestinationReady: boolean
  onSynchronized: () => void
}) {
  const t = useT()
  const [email, setEmail] = React.useState('')
  const [invitationId, setInvitationId] = React.useState<string | null>(null)
  const [affiliate, setAffiliate] = React.useState<EnsureInvitationResponse['affiliate'] | null>(null)
  const [stage, setStage] = React.useState<'idle' | 'inviting' | 'syncing'>('idle')
  const [errorStage, setErrorStage] = React.useState<'invite' | 'sync' | null>(null)
  const { runMutation, retryLastMutation } = useGuardedMutation<InviteMutationContext>({
    contextId: 'finoo-affiliates-invite',
  })

  const reset = React.useCallback(() => {
    setEmail('')
    setInvitationId(null)
    setAffiliate(null)
    setStage('idle')
    setErrorStage(null)
  }, [])

  const synchronize = React.useCallback(async (currentInvitationId: string) => {
    setStage('syncing')
    setErrorStage(null)
    try {
      const payload = { invitationId: currentInvitationId }
      const result = await runMutation({
        operation: () => readApiResultOrThrow<EnsureInvitationResponse>(
          '/api/finoo_affiliates/affiliates/ensure-invitation',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          },
        ),
        mutationPayload: payload,
        context: {
          resourceKind: 'finoo_affiliates.affiliate',
          resourceId: currentInvitationId,
          retryLastMutation,
        },
      })
      setAffiliate(result.affiliate)
      flash(t('finooAffiliates.affiliates.inviteSuccess', 'Affiliate invitation sent and code reserved.'), 'success')
      onSynchronized()
    } catch {
      setErrorStage('sync')
    } finally {
      setStage('idle')
    }
  }, [onSynchronized, retryLastMutation, runMutation, t])

  const submit = React.useCallback(async (event: React.FormEvent) => {
    event.preventDefault()
    if (!email.trim() || stage !== 'idle') return
    setStage('inviting')
    setErrorStage(null)
    try {
      const payload = { email: email.trim(), roleIds: [affiliateRoleId] }
      const result = await runMutation({
        operation: () => readApiResultOrThrow<CoreInviteResponse>(
          '/api/customer_accounts/admin/users-invite',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          },
        ),
        mutationPayload: payload,
        context: {
          resourceKind: 'customer_accounts.invitation',
          retryLastMutation,
        },
      })
      setInvitationId(result.invitation.id)
      await synchronize(result.invitation.id)
    } catch {
      setErrorStage('invite')
      setStage('idle')
    }
  }, [affiliateRoleId, email, retryLastMutation, runMutation, stage, synchronize])

  const handleKeyDown = React.useCallback((event: React.KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault()
      const form = (event.target as HTMLElement).closest('form')
      form?.requestSubmit()
    }
  }, [])

  const close = React.useCallback(() => {
    if (stage !== 'idle') return
    reset()
    onOpenChange(false)
  }, [onOpenChange, reset, stage])

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) close() }}>
      <DialogContent dismissible={stage === 'idle'}>
        <DialogHeader>
          <DialogTitle>{t('finooAffiliates.affiliates.inviteTitle', 'Invite affiliate')}</DialogTitle>
          <DialogDescription>
            {t('finooAffiliates.affiliates.inviteDescription', 'An email invitation will be sent and a unique affiliate code will be reserved.')}
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={(event) => { void submit(event) }} onKeyDown={handleKeyDown}>
          <div className="space-y-2">
            <Label htmlFor="affiliate-invite-email">{t('finooAffiliates.affiliates.email', 'Email')}</Label>
            <EmailInput
              id="affiliate-invite-email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={stage !== 'idle' || Boolean(invitationId)}
              required
              autoFocus
            />
          </div>
          {!defaultDestinationReady ? (
            <p className="text-sm text-status-warning-text">
              {t('finooAffiliates.affiliates.destinationWarning', 'The default destination is not configured. The code will be reserved, but the link cannot be activated yet.')}
            </p>
          ) : null}
          {errorStage === 'invite' ? (
            <p className="text-sm text-destructive">
              {t('finooAffiliates.affiliates.inviteEmailError', 'The invitation email could not be sent. No affiliate was created.')}
            </p>
          ) : null}
          {errorStage === 'sync' ? (
            <p className="text-sm text-destructive">
              {t('finooAffiliates.affiliates.syncError', 'The email was sent, but FINOO could not reserve the affiliate code. Retry synchronization without sending another email.')}
            </p>
          ) : null}
          {affiliate ? (
            <div className="space-y-2 rounded-lg border border-border p-4">
              <p className="text-sm font-medium">{t('finooAffiliates.affiliates.reservedCode', 'Reserved affiliate code')}</p>
              <div className="flex items-center gap-2">
                <code className="text-sm">{affiliate.code}</code>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    void navigator.clipboard.writeText(affiliate.code)
                    flash(t('finooAffiliates.affiliates.codeCopied', 'Affiliate code copied.'), 'success')
                  }}
                >
                  {t('finooAffiliates.affiliates.copyCode', 'Copy code')}
                </Button>
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close} disabled={stage !== 'idle'}>
              {affiliate
                ? t('finooAffiliates.common.close', 'Close')
                : t('finooAffiliates.common.cancel', 'Cancel')}
            </Button>
            {errorStage === 'sync' && invitationId ? (
              <Button type="button" onClick={() => { void synchronize(invitationId) }} disabled={stage !== 'idle'}>
                {stage === 'syncing'
                  ? t('finooAffiliates.affiliates.syncing', 'Synchronizing…')
                  : t('finooAffiliates.affiliates.retrySync', 'Retry sync')}
              </Button>
            ) : !affiliate ? (
              <Button type="submit" disabled={stage !== 'idle' || !email.trim()}>
                {stage === 'inviting'
                  ? t('finooAffiliates.affiliates.sending', 'Sending…')
                  : t('finooAffiliates.affiliates.sendInvite', 'Send invitation')}
              </Button>
            ) : null}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
