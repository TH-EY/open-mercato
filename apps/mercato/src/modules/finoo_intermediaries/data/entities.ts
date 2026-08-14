import { OptionalProps } from '@mikro-orm/core'
import {
  Check,
  Entity,
  Index,
  ManyToOne,
  PrimaryKey,
  Property,
} from '@mikro-orm/decorators/legacy'
import type { PartnerStatus } from '../lib/domain'

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
