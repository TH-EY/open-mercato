import { Entity, Index, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy'
import { OptionalProps } from '@mikro-orm/core'

@Entity({ tableName: 'finoo_affiliate_links' })
@Unique({ name: 'finoo_affiliate_links_code_unique', properties: ['code'] })
@Index({ name: 'finoo_affiliate_links_scope_affiliate_idx', properties: ['tenantId', 'organizationId', 'affiliateUserId'] })
export class FinooAffiliateLink {
  [OptionalProps]?: 'isActive' | 'createdAt' | 'updatedAt' | 'deletedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'affiliate_user_id', type: 'uuid' })
  affiliateUserId!: string

  @Property({ type: 'text' })
  code!: string

  @Property({ type: 'text' })
  label!: string

  @Property({ name: 'destination_url', type: 'text' })
  destinationUrl!: string

  @Property({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean = true

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}

@Entity({ tableName: 'finoo_affiliate_visits' })
@Index({ name: 'finoo_affiliate_visits_unique_window_idx', properties: ['affiliateLinkId', 'visitorHash', 'visitedAt'] })
@Index({ name: 'finoo_affiliate_visits_scope_affiliate_time_idx', properties: ['tenantId', 'organizationId', 'affiliateUserId', 'visitedAt'] })
export class FinooAffiliateVisit {
  [OptionalProps]?: 'visitorHash' | 'createdAt' | 'updatedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'affiliate_link_id', type: 'uuid' })
  affiliateLinkId!: string

  @Property({ name: 'affiliate_user_id', type: 'uuid' })
  affiliateUserId!: string

  @Property({ name: 'visitor_hash', type: 'text', nullable: true })
  visitorHash?: string | null

  @Property({ name: 'visited_at', type: Date })
  visitedAt!: Date

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

@Entity({ tableName: 'finoo_deal_completions' })
@Unique({ name: 'finoo_deal_completions_scope_deal_unique', properties: ['tenantId', 'organizationId', 'dealId'] })
export class FinooDealCompletion {
  [OptionalProps]?: 'createdAt' | 'updatedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'deal_id', type: 'uuid' })
  dealId!: string

  @Property({ name: 'completed_at', type: Date })
  completedAt!: Date

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

export type FinooCommissionStatus = 'approved' | 'waiting' | 'rejected'
export type FinooAttributionSource = 'automatic' | 'staff'
export type FinooAttributionDeletionReason = 'deal' | 'staff'

@Entity({ tableName: 'finoo_deal_attributions' })
@Unique({ name: 'finoo_deal_attributions_scope_deal_unique', properties: ['tenantId', 'organizationId', 'dealId'] })
@Index({ name: 'finoo_deal_attributions_scope_affiliate_lead_idx', properties: ['tenantId', 'organizationId', 'affiliateUserId', 'leadAt'] })
@Index({ name: 'finoo_deal_attributions_scope_affiliate_transaction_idx', properties: ['tenantId', 'organizationId', 'affiliateUserId', 'transactionAt'] })
export class FinooDealAttribution {
  [OptionalProps]?: 'companyName' | 'landingPage' | 'initialReferrer' | 'commissionAmount' | 'transactionAt' | 'attributionSource' | 'deletionReason' | 'createdAt' | 'updatedAt' | 'deletedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'deal_id', type: 'uuid' })
  dealId!: string

  @Property({ name: 'affiliate_user_id', type: 'uuid' })
  affiliateUserId!: string

  @Property({ name: 'affiliate_code', type: 'text' })
  affiliateCode!: string

  @Property({ name: 'company_name', type: 'text', nullable: true })
  companyName?: string | null

  @Property({ name: 'landing_page', type: 'text', nullable: true })
  landingPage?: string | null

  @Property({ name: 'initial_referrer', type: 'text', nullable: true })
  initialReferrer?: string | null

  @Property({ name: 'commission_status_entry_id', type: 'uuid' })
  commissionStatusEntryId!: string

  @Property({ name: 'commission_status', type: 'text' })
  commissionStatus!: FinooCommissionStatus

  @Property({ name: 'commission_amount', type: 'int', default: 0 })
  commissionAmount: number = 0

  @Property({ name: 'lead_at', type: Date })
  leadAt!: Date

  @Property({ name: 'transaction_at', type: Date, nullable: true })
  transactionAt?: Date | null

  @Property({ name: 'attribution_source', type: 'text', default: 'automatic' })
  attributionSource: FinooAttributionSource = 'automatic'

  @Property({ name: 'deletion_reason', type: 'text', nullable: true })
  deletionReason?: FinooAttributionDeletionReason | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}
