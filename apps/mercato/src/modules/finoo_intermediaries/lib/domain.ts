export const ELIGIBLE_STAGE_LABEL = 'sent to partners'
export const ELIGIBLE_PIPELINE_NAME = 'web form sales pipeline'

export type PartnerStatus = 'new' | 'in_progress' | 'done'
export type IntermediaryLifecycleState = 'delivery_failed' | 'invited' | 'active' | 'inactive'
export type EffectiveIntermediaryStatus = IntermediaryLifecycleState | 'expired'
export type IntermediaryEmailKind = 'invitation' | 'access_notice'
export type IntermediaryEmailStatus = 'pending' | 'delivered' | 'failed'

export type IntermediaryLifecycleSnapshot = {
  lifecycleState: IntermediaryLifecycleState
  invitationExpiresAt?: Date | null
}

export type AssignmentScope = {
  tenantId: string
  organizationId: string
}

export type AssignmentIdentity = AssignmentScope & {
  dealId?: string
  intermediaryCustomerUserId?: string
}

export function normalizeStageLabel(label: string): string {
  return label.trim().toLowerCase()
}

export function isExactEligibleStageLabel(label: string): boolean {
  return normalizeStageLabel(label) === ELIGIBLE_STAGE_LABEL
}

export function isExactEligiblePipelineName(name: string): boolean {
  return normalizeStageLabel(name) === ELIGIBLE_PIPELINE_NAME
}

export function isLegalPartnerStatusTransition(
  current: PartnerStatus,
  next: PartnerStatus,
): boolean {
  return (current === 'new' && next === 'in_progress')
    || (current === 'in_progress' && next === 'done')
}

export function resolveEffectiveIntermediaryStatus(
  intermediary: IntermediaryLifecycleSnapshot,
  now: Date = new Date(),
): EffectiveIntermediaryStatus {
  if (
    intermediary.lifecycleState === 'invited'
    && intermediary.invitationExpiresAt
    && intermediary.invitationExpiresAt.getTime() <= now.getTime()
  ) {
    return 'expired'
  }
  return intermediary.lifecycleState
}

export function scopedActiveAssignmentWhere(identity: AssignmentIdentity) {
  return {
    tenantId: identity.tenantId,
    organizationId: identity.organizationId,
    ...(identity.dealId ? { dealId: identity.dealId } : {}),
    ...(identity.intermediaryCustomerUserId
      ? { intermediaryCustomerUserId: identity.intermediaryCustomerUserId }
      : {}),
    deletedAt: null,
  }
}
