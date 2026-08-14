import { Entity, Index, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy'
import { OptionalProps } from '@mikro-orm/core'

@Entity({ tableName: 'finoo_affiliate_links' })
@Unique({ name: 'finoo_affiliate_links_code_unique', properties: ['code'] })
@Index({ name: 'finoo_affiliate_links_scope_affiliate_idx', properties: ['tenantId', 'organizationId', 'affiliateUserId'] })
@Index({ name: 'finoo_affiliate_links_scope_membership_idx', properties: ['tenantId', 'organizationId', 'affiliateId'] })
export class FinooAffiliateLink {
  [OptionalProps]?: 'affiliateId' | 'isActive' | 'createdAt' | 'updatedAt' | 'deletedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'affiliate_user_id', type: 'uuid' })
  affiliateUserId!: string

  @Property({ name: 'affiliate_id', type: 'uuid', nullable: true })
  affiliateId?: string | null

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
export type FinooAffiliateTransactionStatus = 'processing' | 'approved' | 'rejected' | 'paid_out'
export type FinooAffiliateCommissionMode = 'percentage' | 'fixed'
export type FinooAffiliateTransactionCommissionMode = 'legacy_deal_amount' | FinooAffiliateCommissionMode
export type FinooAttributionSource = 'automatic' | 'staff'
export type FinooAttributionDeletionReason = 'deal' | 'staff'
export type FinooPayoutSelectionItem = { id: string; updatedAt: string }

@Entity({ tableName: 'finoo_deal_attributions' })
@Unique({ name: 'finoo_deal_attributions_scope_deal_unique', properties: ['tenantId', 'organizationId', 'dealId'] })
@Index({ name: 'finoo_deal_attributions_scope_affiliate_lead_idx', properties: ['tenantId', 'organizationId', 'affiliateUserId', 'leadAt'] })
@Index({ name: 'finoo_deal_attributions_scope_affiliate_transaction_idx', properties: ['tenantId', 'organizationId', 'affiliateUserId', 'transactionAt'] })
@Index({ name: 'finoo_deal_attributions_scope_membership_idx', properties: ['tenantId', 'organizationId', 'affiliateId'] })
export class FinooDealAttribution {
  [OptionalProps]?: 'affiliateId' | 'companyName' | 'landingPage' | 'initialReferrer' | 'commissionAmount' | 'transactionAt' | 'attributionSource' | 'deletionReason' | 'createdAt' | 'updatedAt' | 'deletedAt'

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

  @Property({ name: 'affiliate_id', type: 'uuid', nullable: true })
  affiliateId?: string | null

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

@Entity({ tableName: 'finoo_affiliates' })
@Unique({ name: 'finoo_affiliates_code_unique', properties: ['code'] })
@Index({
  name: 'finoo_affiliates_scope_email_hash_unique',
  expression:
    'create unique index "finoo_affiliates_scope_email_hash_unique" on "finoo_affiliates" ("tenant_id", "organization_id", "email_hash") where "deleted_at" is null',
})
@Index({
  name: 'finoo_affiliates_scope_invitation_unique',
  expression:
    'create unique index "finoo_affiliates_scope_invitation_unique" on "finoo_affiliates" ("tenant_id", "organization_id", "invitation_id") where "invitation_id" is not null and "deleted_at" is null',
})
@Index({
  name: 'finoo_affiliates_scope_customer_user_unique',
  expression:
    'create unique index "finoo_affiliates_scope_customer_user_unique" on "finoo_affiliates" ("tenant_id", "organization_id", "customer_user_id") where "customer_user_id" is not null and "deleted_at" is null',
})
@Index({ name: 'finoo_affiliates_scope_active_idx', properties: ['tenantId', 'organizationId', 'isActive', 'createdAt'] })
export class FinooAffiliate {
  [OptionalProps]?: 'invitationId' | 'customerUserId' | 'primaryLinkId' | 'accountHolderName' | 'accountNumber' | 'commissionMode' | 'commissionRateBps' | 'commissionFixedAmount' | 'isActive' | 'createdAt' | 'updatedAt' | 'deletedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'invitation_id', type: 'uuid', nullable: true })
  invitationId?: string | null

  @Property({ name: 'customer_user_id', type: 'uuid', nullable: true })
  customerUserId?: string | null

  @Property({ type: 'text' })
  email!: string

  @Property({ name: 'email_hash', type: 'text' })
  emailHash!: string

  @Property({ type: 'text' })
  code!: string

  @Property({ name: 'primary_link_id', type: 'uuid', nullable: true })
  primaryLinkId?: string | null

  @Property({ name: 'account_holder_name', type: 'text', nullable: true })
  accountHolderName?: string | null

  @Property({ name: 'account_number', type: 'text', nullable: true })
  accountNumber?: string | null

  @Property({ name: 'commission_mode', type: 'text', nullable: true })
  commissionMode?: FinooAffiliateCommissionMode | null

  @Property({ name: 'commission_rate_bps', type: 'int', nullable: true })
  commissionRateBps?: number | null

  @Property({ name: 'commission_fixed_amount', type: 'int', nullable: true })
  commissionFixedAmount?: number | null

  @Property({ name: 'is_active', type: 'boolean', default: false })
  isActive: boolean = false

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}

@Entity({ tableName: 'finoo_deal_acceptances' })
@Unique({ name: 'finoo_deal_acceptances_scope_deal_unique', properties: ['tenantId', 'organizationId', 'dealId'] })
export class FinooDealAcceptance {
  [OptionalProps]?: 'dealValueAmount' | 'dealValueCurrency' | 'createdAt' | 'updatedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'deal_id', type: 'uuid' })
  dealId!: string

  @Property({ name: 'accepted_at', type: Date })
  acceptedAt!: Date

  @Property({ name: 'deal_value_amount', type: 'numeric', precision: 14, scale: 2, nullable: true })
  dealValueAmount?: string | null

  @Property({ name: 'deal_value_currency', type: 'text', nullable: true })
  dealValueCurrency?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

@Entity({ tableName: 'finoo_affiliate_transactions' })
@Unique({ name: 'finoo_affiliate_transactions_scope_deal_unique', properties: ['tenantId', 'organizationId', 'dealId'] })
@Index({ name: 'finoo_affiliate_transactions_scope_status_idx', properties: ['tenantId', 'organizationId', 'affiliateId', 'commissionStatus', 'acceptedAt'] })
@Index({ name: 'finoo_affiliate_transactions_scope_user_time_idx', properties: ['tenantId', 'organizationId', 'affiliateUserId', 'acceptedAt'] })
@Index({ name: 'finoo_affiliate_transactions_scope_payout_idx', properties: ['tenantId', 'organizationId', 'payoutId'] })
export class FinooAffiliateTransaction {
  [OptionalProps]?: 'dealName' | 'dealCompany' | 'commissionMode' | 'commissionRateBps' | 'commissionFixedAmount' | 'commissionBaseAmount' | 'currency' | 'payoutId' | 'createdEventPublishedAt' | 'createdAt' | 'updatedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'affiliate_id', type: 'uuid' })
  affiliateId!: string

  @Property({ name: 'affiliate_user_id', type: 'uuid' })
  affiliateUserId!: string

  @Property({ name: 'deal_id', type: 'uuid' })
  dealId!: string

  @Property({ name: 'deal_name', type: 'text', nullable: true })
  dealName?: string | null

  @Property({ name: 'deal_company', type: 'text', nullable: true })
  dealCompany?: string | null

  @Property({ name: 'commission_amount', type: 'int' })
  commissionAmount!: number

  @Property({ name: 'commission_mode', type: 'text', default: 'legacy_deal_amount' })
  commissionMode: FinooAffiliateTransactionCommissionMode = 'legacy_deal_amount'

  @Property({ name: 'commission_rate_bps', type: 'int', nullable: true })
  commissionRateBps?: number | null

  @Property({ name: 'commission_fixed_amount', type: 'int', nullable: true })
  commissionFixedAmount?: number | null

  @Property({ name: 'commission_base_amount', type: 'numeric', precision: 14, scale: 2, nullable: true })
  commissionBaseAmount?: string | null

  @Property({ type: 'text', default: 'PLN' })
  currency: string = 'PLN'

  @Property({ name: 'commission_status_entry_id', type: 'uuid' })
  commissionStatusEntryId!: string

  @Property({ name: 'commission_status', type: 'text' })
  commissionStatus!: FinooAffiliateTransactionStatus

  @Property({ name: 'accepted_at', type: Date })
  acceptedAt!: Date

  @Property({ name: 'payout_id', type: 'uuid', nullable: true })
  payoutId?: string | null

  @Property({ name: 'created_event_published_at', type: Date, nullable: true })
  createdEventPublishedAt?: Date | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

@Entity({ tableName: 'finoo_affiliate_payouts' })
@Unique({ name: 'finoo_affiliate_payouts_reference_unique', properties: ['paymentReference'] })
@Index({ name: 'finoo_affiliate_payouts_scope_affiliate_time_idx', properties: ['tenantId', 'organizationId', 'affiliateId', 'paidAt'] })
export class FinooAffiliatePayout {
  [OptionalProps]?: 'currency' | 'createdEventPublishedAt' | 'createdAt' | 'updatedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'affiliate_id', type: 'uuid' })
  affiliateId!: string

  @Property({ name: 'affiliate_user_id', type: 'uuid' })
  affiliateUserId!: string

  @Property({ name: 'payment_reference', type: 'text' })
  paymentReference!: string

  @Property({ type: 'string', columnType: 'bigint' })
  amount!: string

  @Property({ type: 'text', default: 'PLN' })
  currency: string = 'PLN'

  @Property({ name: 'account_holder_name', type: 'text' })
  accountHolderName!: string

  @Property({ name: 'account_number', type: 'text' })
  accountNumber!: string

  @Property({ name: 'paid_at', type: Date })
  paidAt!: Date

  @Property({ name: 'created_event_published_at', type: Date, nullable: true })
  createdEventPublishedAt?: Date | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

@Entity({ tableName: 'finoo_payout_previews' })
@Unique({ name: 'finoo_payout_previews_reference_unique', properties: ['paymentReference'] })
@Index({ name: 'finoo_payout_previews_scope_expiry_idx', properties: ['tenantId', 'organizationId', 'expiresAt'] })
@Index({ name: 'finoo_payout_previews_scope_payout_idx', properties: ['tenantId', 'organizationId', 'payoutId'] })
export class FinooPayoutPreview {
  [OptionalProps]?: 'currency' | 'payoutId' | 'createdAt' | 'updatedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'payment_reference', type: 'text' })
  paymentReference!: string

  @Property({ name: 'affiliate_id', type: 'uuid' })
  affiliateId!: string

  @Property({ name: 'binding_hash', type: 'text' })
  bindingHash!: string

  @Property({ type: 'jsonb' })
  selection!: FinooPayoutSelectionItem[]

  @Property({ type: 'string', columnType: 'bigint' })
  amount!: string

  @Property({ type: 'text', default: 'PLN' })
  currency: string = 'PLN'

  @Property({ name: 'expires_at', type: Date })
  expiresAt!: Date

  @Property({ name: 'payout_id', type: 'uuid', nullable: true })
  payoutId?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}
