import { OptionalProps } from '@mikro-orm/core'
import {
  Check,
  Entity,
  Index,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/decorators/legacy'

export const FINOO_CUSTOMER_RETENTION_STATUSES = ['active', 'expired', 'excluded'] as const
export type FinooCustomerRetentionStatus = typeof FINOO_CUSTOMER_RETENTION_STATUSES[number]

@Entity({ tableName: 'finoo_customer_retention_settings' })
@Unique({
  name: 'finoo_customer_retention_settings_scope_unique',
  properties: ['tenantId', 'organizationId'],
})
@Check({
  name: 'finoo_customer_retention_settings_window_days_check',
  expression: '"inactivity_window_days" is null or "inactivity_window_days" between 1 and 3650',
})
export class FinooCustomerRetentionSettings {
  [OptionalProps]?:
    | 'inactivityWindowDays'
    | 'previewTokenHash'
    | 'previewWindowDays'
    | 'previewTotalEligible'
    | 'previewNewlyExpired'
    | 'previewAlreadyExpired'
    | 'previewExpiresAt'
    | 'reconciliationGeneration'
    | 'createdAt'
    | 'updatedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'inactivity_window_days', type: 'int', nullable: true })
  inactivityWindowDays?: number | null

  @Property({ name: 'preview_token_hash', type: 'string', length: 64, nullable: true })
  previewTokenHash?: string | null

  @Property({ name: 'preview_window_days', type: 'int', nullable: true })
  previewWindowDays?: number | null

  @Property({ name: 'preview_total_eligible', type: 'int', nullable: true })
  previewTotalEligible?: number | null

  @Property({ name: 'preview_newly_expired', type: 'int', nullable: true })
  previewNewlyExpired?: number | null

  @Property({ name: 'preview_already_expired', type: 'int', nullable: true })
  previewAlreadyExpired?: number | null

  @Property({ name: 'preview_expires_at', type: Date, nullable: true })
  previewExpiresAt?: Date | null

  @Property({ name: 'reconciliation_generation', type: 'int', default: 0 })
  reconciliationGeneration: number = 0

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

@Entity({ tableName: 'finoo_customer_retention_states' })
@Index({
  name: 'finoo_customer_retention_states_scope_customer_unique',
  expression: 'create unique index "finoo_customer_retention_states_scope_customer_unique" on "finoo_customer_retention_states" ("tenant_id", "organization_id", "customer_entity_id") where "deleted_at" is null',
})
@Index({
  name: 'finoo_customer_retention_states_scope_expiry_idx',
  properties: ['tenantId', 'organizationId', 'retentionStatus', 'retentionExpiresAt'],
})
@Index({
  name: 'finoo_customer_retention_states_scope_customer_keyset_idx',
  properties: ['tenantId', 'organizationId', 'customerEntityId', 'id'],
})
@Index({
  name: 'finoo_customer_retention_states_scope_pending_erasure_idx',
  expression: 'create index "finoo_customer_retention_states_scope_pending_erasure_idx" on "finoo_customer_retention_states" ("tenant_id", "organization_id", "retention_status", "retention_expires_at", "customer_entity_id") where "deleted_at" is null and "identity_erased_at" is null',
})
@Check({
  name: 'finoo_customer_retention_states_status_check',
  expression: '"retention_status" in (\'active\', \'expired\', \'excluded\')',
})
export class FinooCustomerRetentionState {
  [OptionalProps]?:
    | 'lastQualifyingActivityAt'
    | 'retentionExpiresAt'
    | 'expiredAt'
    | 'identityErasedAt'
    | 'retentionStatus'
    | 'createdAt'
    | 'updatedAt'
    | 'deletedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'customer_entity_id', type: 'uuid' })
  customerEntityId!: string

  @Property({ name: 'retention_status', type: 'text', default: 'active' })
  retentionStatus: FinooCustomerRetentionStatus = 'active'

  @Property({ name: 'eligibility_anchor_at', type: Date })
  eligibilityAnchorAt!: Date

  @Property({ name: 'last_qualifying_activity_at', type: Date, nullable: true })
  lastQualifyingActivityAt?: Date | null

  @Property({ name: 'retention_expires_at', type: Date, nullable: true })
  retentionExpiresAt?: Date | null

  @Property({ name: 'expired_at', type: Date, nullable: true })
  expiredAt?: Date | null

  @Property({ name: 'identity_erased_at', type: Date, nullable: true })
  identityErasedAt?: Date | null

  @Property({ name: 'last_evaluated_at', type: Date })
  lastEvaluatedAt!: Date

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}
