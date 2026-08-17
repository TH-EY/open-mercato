import { OptionalProps } from '@mikro-orm/core'
import {
  Check,
  Entity,
  Index,
  ManyToOne,
  PrimaryKey,
  Property,
} from '@mikro-orm/decorators/legacy'
import type {
  IntermediaryEmailKind,
  IntermediaryEmailStatus,
  IntermediaryLifecycleState,
  PartnerStatus,
} from '../lib/domain'

@Entity({ tableName: 'finoo_intermediaries' })
@Index({
  name: 'finoo_intermediaries_scope_email_hash_uq',
  expression: `create unique index "finoo_intermediaries_scope_email_hash_uq" on "finoo_intermediaries" ("tenant_id", "organization_id", "email_hash") where "deleted_at" is null`,
})
@Index({
  name: 'finoo_intermediaries_scope_invitation_uq',
  expression: `create unique index "finoo_intermediaries_scope_invitation_uq" on "finoo_intermediaries" ("tenant_id", "organization_id", "invitation_id") where "invitation_id" is not null and "deleted_at" is null`,
})
@Index({
  name: 'finoo_intermediaries_scope_customer_user_uq',
  expression: `create unique index "finoo_intermediaries_scope_customer_user_uq" on "finoo_intermediaries" ("tenant_id", "organization_id", "customer_user_id") where "customer_user_id" is not null and "deleted_at" is null`,
})
@Index({
  name: 'finoo_intermediaries_list_idx',
  properties: ['tenantId', 'organizationId', 'lifecycleState', 'deletedAt', 'updatedAt', 'id'],
})
@Check({
  name: 'finoo_intermediaries_lifecycle_state_chk',
  expression: `"lifecycle_state" in ('delivery_failed', 'invited', 'active', 'inactive')`,
})
@Check({
  name: 'finoo_intermediaries_email_kind_chk',
  expression: `"last_email_kind" is null or "last_email_kind" in ('invitation', 'access_notice')`,
})
@Check({
  name: 'finoo_intermediaries_email_status_chk',
  expression: `"last_email_status" is null or "last_email_status" in ('pending', 'delivered', 'failed')`,
})
export class FinooIntermediary {
  [OptionalProps]?: 'invitationId' | 'customerUserId' | 'invitationExpiresAt' | 'lastEmailKind' | 'lastEmailStatus' | 'lastEmailAttemptAt' | 'lastEmailDeliveredAt' | 'lastEmailErrorCode' | 'activatedAt' | 'deactivatedAt' | 'createdByUserId' | 'updatedByUserId' | 'createdAt' | 'updatedAt' | 'deletedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'first_name', type: 'text' })
  firstName!: string

  @Property({ name: 'last_name', type: 'text' })
  lastName!: string

  @Property({ type: 'text' })
  email!: string

  @Property({ name: 'email_hash', type: 'text' })
  emailHash!: string

  @Property({ name: 'lifecycle_state', type: 'text', default: 'delivery_failed' })
  lifecycleState: IntermediaryLifecycleState = 'delivery_failed'

  @Property({ name: 'invitation_id', type: 'uuid', nullable: true })
  invitationId?: string | null

  @Property({ name: 'customer_user_id', type: 'uuid', nullable: true })
  customerUserId?: string | null

  @Property({ name: 'invitation_expires_at', type: Date, nullable: true })
  invitationExpiresAt?: Date | null

  @Property({ name: 'last_email_kind', type: 'text', nullable: true })
  lastEmailKind?: IntermediaryEmailKind | null

  @Property({ name: 'last_email_status', type: 'text', nullable: true })
  lastEmailStatus?: IntermediaryEmailStatus | null

  @Property({ name: 'last_email_attempt_at', type: Date, nullable: true })
  lastEmailAttemptAt?: Date | null

  @Property({ name: 'last_email_delivered_at', type: Date, nullable: true })
  lastEmailDeliveredAt?: Date | null

  @Property({ name: 'last_email_error_code', type: 'text', nullable: true })
  lastEmailErrorCode?: string | null

  @Property({ name: 'activated_at', type: Date, nullable: true })
  activatedAt?: Date | null

  @Property({ name: 'deactivated_at', type: Date, nullable: true })
  deactivatedAt?: Date | null

  @Property({ name: 'created_by_user_id', type: 'uuid', nullable: true })
  createdByUserId?: string | null

  @Property({ name: 'updated_by_user_id', type: 'uuid', nullable: true })
  updatedByUserId?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}

@Entity({ tableName: 'finoo_intermediary_assignments' })
@Index({
  name: 'finoo_intermediary_assignments_active_deal_uq',
  expression: `create unique index "finoo_intermediary_assignments_active_deal_uq" on "finoo_intermediary_assignments" ("tenant_id", "organization_id", "deal_id") where "deleted_at" is null`,
})
@Index({
  name: 'finoo_intermediary_assignments_portal_idx',
  properties: ['tenantId', 'organizationId', 'intermediaryCustomerUserId', 'deletedAt', 'updatedAt', 'id'],
})
@Index({
  name: 'finoo_intermediary_assignments_staff_idx',
  properties: ['tenantId', 'organizationId', 'dealId', 'deletedAt'],
})
@Check({
  name: 'finoo_intermediary_assignments_partner_status_chk',
  expression: `"partner_status" in ('new', 'in_progress', 'done')`,
})
export class FinooIntermediaryAssignment {
  [OptionalProps]?: 'partnerStatus' | 'statusUpdatedByCustomerUserId' | 'statusUpdatedAt' | 'createdAt' | 'updatedAt' | 'deletedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'deal_id', type: 'uuid' })
  dealId!: string

  @Property({ name: 'intermediary_customer_user_id', type: 'uuid' })
  intermediaryCustomerUserId!: string

  @Property({ name: 'intermediary_role_id', type: 'uuid' })
  intermediaryRoleId!: string

  @Property({ name: 'eligible_stage_id', type: 'uuid' })
  eligibleStageId!: string

  @Property({ name: 'partner_status', type: 'text', default: 'new' })
  partnerStatus: PartnerStatus = 'new'

  @Property({ name: 'assigned_by_user_id', type: 'uuid' })
  assignedByUserId!: string

  @Property({ name: 'status_updated_by_customer_user_id', type: 'uuid', nullable: true })
  statusUpdatedByCustomerUserId?: string | null

  @Property({ name: 'status_updated_at', type: Date, nullable: true })
  statusUpdatedAt?: Date | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}

@Entity({ tableName: 'finoo_intermediary_notes' })
@Index({
  name: 'finoo_intermediary_notes_portal_idx',
  properties: ['tenantId', 'organizationId', 'assignment', 'authorCustomerUserId', 'deletedAt', 'createdAt', 'id'],
})
@Index({
  name: 'finoo_intermediary_notes_staff_idx',
  properties: ['tenantId', 'organizationId', 'assignment', 'deletedAt', 'createdAt', 'id'],
})
export class FinooIntermediaryNote {
  [OptionalProps]?: 'createdAt' | 'updatedAt' | 'deletedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @ManyToOne(() => FinooIntermediaryAssignment, { fieldName: 'assignment_id' })
  assignment!: FinooIntermediaryAssignment

  @Property({ name: 'author_customer_user_id', type: 'uuid' })
  authorCustomerUserId!: string

  @Property({ type: 'text' })
  body!: string

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}
