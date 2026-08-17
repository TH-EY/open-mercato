import type { EntityManager } from '@mikro-orm/postgresql'

export const FINOO_INTERMEDIARY_ACCEPTANCE_RECONCILIATION_QUEUE =
  'finoo-intermediaries-acceptance-reconciliation'
export const FINOO_INTERMEDIARY_ACCEPTANCE_RECONCILIATION_BATCH_SIZE = 100

type AcceptedInvitationRow = {
  invitation_id: string
  user_id: string
  accepted_at: Date | string
}

export type IntermediaryAcceptanceReconciliationCursor = {
  acceptedAt: string
  invitationId: string
}

export type IntermediaryAcceptanceReconciliationResult = {
  selected: number
  succeeded: number
  failed: number
  continuation: IntermediaryAcceptanceReconciliationCursor | null
}

type ReconciliationOptions = {
  batchSize?: number
  after?: IntermediaryAcceptanceReconciliationCursor | null
  onFailure?: (invitationId: string, error: unknown) => void
}

export async function reconcileAcceptedIntermediaryInvitations(
  em: EntityManager,
  scope: { tenantId: string; organizationId: string },
  activate: (input: { invitationId: string; userId: string }) => Promise<boolean>,
  options: ReconciliationOptions = {},
): Promise<IntermediaryAcceptanceReconciliationResult> {
  const batchSize = options.batchSize ?? FINOO_INTERMEDIARY_ACCEPTANCE_RECONCILIATION_BATCH_SIZE
  const cursorPredicate = options.after
    ? 'and (invitation.accepted_at, invitation.id) > (?, ?)'
    : ''
  const rows = await em.getConnection().execute<AcceptedInvitationRow[]>(
    `select invitation.id as invitation_id, customer_user.id as user_id, invitation.accepted_at
       from finoo_intermediaries intermediary
       inner join customer_user_invitations invitation
         on invitation.id = intermediary.invitation_id
        and invitation.tenant_id = intermediary.tenant_id
        and invitation.organization_id = intermediary.organization_id
        and invitation.email_hash = intermediary.email_hash
        and invitation.accepted_at is not null
        and invitation.cancelled_at is null
       inner join customer_users customer_user
         on customer_user.tenant_id = intermediary.tenant_id
        and customer_user.organization_id = intermediary.organization_id
        and customer_user.email_hash = intermediary.email_hash
        and customer_user.is_active = true
        and customer_user.deleted_at is null
      where intermediary.tenant_id = ?
        and intermediary.organization_id = ?
        and intermediary.customer_user_id is null
        and intermediary.lifecycle_state in ('delivery_failed', 'invited')
        and intermediary.deleted_at is null
        ${cursorPredicate}
      order by invitation.accepted_at asc, invitation.id asc
      limit ?`,
    [
      scope.tenantId,
      scope.organizationId,
      ...(options.after ? [options.after.acceptedAt, options.after.invitationId] : []),
      batchSize,
    ],
  )

  let succeeded = 0
  let failed = 0
  for (const row of rows) {
    try {
      if (await activate({ invitationId: row.invitation_id, userId: row.user_id })) succeeded += 1
    } catch (error) {
      failed += 1
      options.onFailure?.(row.invitation_id, error)
    }
  }

  const last = rows.at(-1)
  return {
    selected: rows.length,
    succeeded,
    failed,
    continuation: last
      ? {
          acceptedAt: new Date(last.accepted_at).toISOString(),
          invitationId: last.invitation_id,
        }
      : null,
  }
}
