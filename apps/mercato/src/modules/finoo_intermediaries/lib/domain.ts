export const ELIGIBLE_STAGE_LABEL = 'sent to partners'
export const ELIGIBLE_PIPELINE_NAME = 'web form sales pipeline'

export type PartnerStatus = 'new' | 'in_progress' | 'done'

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
