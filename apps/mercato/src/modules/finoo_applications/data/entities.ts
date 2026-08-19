import { Entity, Index, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy'
import { OptionalProps } from '@mikro-orm/core'
import type { SanitizedFinooApplicationPayload } from './validators'

export type FinooApplicationIntakeState = 'pending' | 'processing' | 'retrying' | 'processed' | 'failed'
export type FinooApplicationDispatchState = 'pending' | 'dispatching' | 'enqueued'
export type FinooApplicationProjectionState = 'draft' | 'completed' | 'disqualified'

@Entity({ tableName: 'finoo_application_intakes' })
@Unique({ name: 'finoo_application_intakes_scope_message_unique', properties: ['tenantId', 'organizationId', 'messageId'] })
@Index({ name: 'finoo_application_intakes_delivery_idx', properties: ['state', 'nextAttemptAt', 'leaseExpiresAt'] })
export class FinooApplicationIntake {
  [OptionalProps]?: 'state' | 'dispatchState' | 'dispatchLeaseExpiresAt' | 'attemptCount' | 'lastErrorCode' | 'nextAttemptAt' | 'leaseExpiresAt' | 'processedAt' | 'createdAt' | 'updatedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' }) id!: string
  @Property({ name: 'tenant_id', type: 'uuid' }) tenantId!: string
  @Property({ name: 'organization_id', type: 'uuid' }) organizationId!: string
  @Property({ name: 'message_id', type: 'text' }) messageId!: string
  @Property({ name: 'body_digest', type: 'text' }) bodyDigest!: string
  @Property({ name: 'external_lead_id', type: 'text' }) externalLeadId!: string
  @Property({ name: 'source_timestamp', type: Date }) sourceTimestamp!: Date
  @Property({ name: 'payload_json', type: 'json', nullable: true }) payloadJson?: SanitizedFinooApplicationPayload | null
  @Property({ type: 'text', default: 'pending' }) state: FinooApplicationIntakeState = 'pending'
  @Property({ name: 'dispatch_state', type: 'text', default: 'pending' }) dispatchState: FinooApplicationDispatchState = 'pending'
  @Property({ name: 'dispatch_lease_expires_at', type: Date, nullable: true }) dispatchLeaseExpiresAt?: Date | null
  @Property({ name: 'attempt_count', type: 'int', default: 0 }) attemptCount: number = 0
  @Property({ name: 'last_error_code', type: 'text', nullable: true }) lastErrorCode?: string | null
  @Property({ name: 'next_attempt_at', type: Date, nullable: true }) nextAttemptAt?: Date | null
  @Property({ name: 'lease_expires_at', type: Date, nullable: true }) leaseExpiresAt?: Date | null
  @Property({ name: 'processed_at', type: Date, nullable: true }) processedAt?: Date | null
  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() }) createdAt: Date = new Date()
  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() }) updatedAt: Date = new Date()
}

@Entity({ tableName: 'finoo_application_projections' })
@Unique({ name: 'finoo_application_projections_scope_lead_unique', properties: ['tenantId', 'organizationId', 'externalLeadId'] })
export class FinooApplicationProjection {
  [OptionalProps]?: 'state' | 'companyEntityId' | 'applicantEntityId' | 'dealId' | 'lastIntakeId' | 'lastSourceTimestamp' | 'warningsJson' | 'submissionHistoryJson' | 'lastErrorCode' | 'createdAt' | 'updatedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' }) id!: string
  @Property({ name: 'tenant_id', type: 'uuid' }) tenantId!: string
  @Property({ name: 'organization_id', type: 'uuid' }) organizationId!: string
  @Property({ name: 'external_lead_id', type: 'text' }) externalLeadId!: string
  @Property({ type: 'text', default: 'draft' }) state: FinooApplicationProjectionState = 'draft'
  @Property({ name: 'company_entity_id', type: 'uuid', nullable: true }) companyEntityId?: string | null
  @Property({ name: 'applicant_entity_id', type: 'uuid', nullable: true }) applicantEntityId?: string | null
  @Property({ name: 'deal_id', type: 'uuid', nullable: true }) dealId?: string | null
  @Property({ name: 'last_intake_id', type: 'uuid', nullable: true }) lastIntakeId?: string | null
  @Property({ name: 'last_source_timestamp', type: Date, nullable: true }) lastSourceTimestamp?: Date | null
  @Property({ name: 'warnings_json', type: 'json', default: '[]' }) warningsJson: string[] = []
  @Property({ name: 'submission_history_json', type: 'json', default: '[]' }) submissionHistoryJson: Array<Record<string, unknown>> = []
  @Property({ name: 'last_error_code', type: 'text', nullable: true }) lastErrorCode?: string | null
  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() }) createdAt: Date = new Date()
  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() }) updatedAt: Date = new Date()
}

@Entity({ tableName: 'finoo_application_identity_bindings' })
@Unique({ name: 'finoo_application_identity_scope_key_unique', properties: ['tenantId', 'organizationId', 'identityKind', 'identityHash'] })
export class FinooApplicationIdentityBinding {
  [OptionalProps]?: 'projectionId' | 'customerEntityId' | 'createdAt' | 'updatedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' }) id!: string
  @Property({ name: 'tenant_id', type: 'uuid' }) tenantId!: string
  @Property({ name: 'organization_id', type: 'uuid' }) organizationId!: string
  @Property({ name: 'projection_id', type: 'uuid', nullable: true }) projectionId?: string | null
  @Property({ name: 'identity_kind', type: 'text' }) identityKind!: 'nip' | 'pesel' | 'email'
  @Property({ name: 'identity_hash', type: 'text' }) identityHash!: string
  @Property({ name: 'reserved_entity_id', type: 'uuid' }) reservedEntityId!: string
  @Property({ name: 'customer_entity_id', type: 'uuid', nullable: true }) customerEntityId?: string | null
  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() }) createdAt: Date = new Date()
  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() }) updatedAt: Date = new Date()
}

@Entity({ tableName: 'finoo_application_consent_evidence' })
@Unique({ name: 'finoo_application_consent_evidence_intake_key_unique', properties: ['tenantId', 'organizationId', 'intakeId', 'consentKey'] })
export class FinooApplicationConsentEvidence {
  [OptionalProps]?: 'createdAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' }) id!: string
  @Property({ name: 'tenant_id', type: 'uuid' }) tenantId!: string
  @Property({ name: 'organization_id', type: 'uuid' }) organizationId!: string
  @Property({ name: 'intake_id', type: 'uuid' }) intakeId!: string
  @Property({ name: 'projection_id', type: 'uuid' }) projectionId!: string
  @Property({ name: 'consent_key', type: 'text' }) consentKey!: string
  @Property({ name: 'registry_version', type: 'text' }) registryVersion!: string
  @Property({ name: 'registry_code', type: 'text' }) registryCode!: string
  @Property({ type: 'boolean' }) accepted!: boolean
  @Property({ name: 'accepted_at', type: Date }) acceptedAt!: Date
  @Property({ name: 'transport_source_ip_digest', type: 'text', nullable: true }) transportSourceIpDigest?: string | null
  @Property({ name: 'evidence_digest', type: 'text' }) evidenceDigest!: string
  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() }) createdAt: Date = new Date()
}
