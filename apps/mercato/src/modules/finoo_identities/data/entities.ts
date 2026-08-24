import { OptionalProps } from '@mikro-orm/core'
import { Check, Entity, Index, PrimaryKey, Property } from '@mikro-orm/decorators/legacy'
import type { IdentityDocumentType, IdentityFieldStatuses } from '../lib/identity-domain'

const EMPTY_IDENTITY_FIELD_STATUSES: IdentityFieldStatuses = {
  pesel: 'missing',
  documentType: 'missing',
  issuingCountryCode: 'missing',
  documentNumber: 'missing',
  issuedOn: 'missing',
  expiresOn: 'missing',
}

@Entity({ tableName: 'finoo_person_identities' })
@Index({
  name: 'finoo_person_identities_active_person_uq',
  expression: `create unique index "finoo_person_identities_active_person_uq" on "finoo_person_identities" ("tenant_id", "organization_id", "person_id") where "deleted_at" is null`,
})
@Index({
  name: 'finoo_person_identities_completeness_idx',
  properties: ['tenantId', 'organizationId', 'isComplete', 'personId'],
})
export class FinooPersonIdentity {
  [OptionalProps]?: 'pesel' | 'documentType' | 'issuingCountryCode' | 'documentNumber' | 'issuedOn' | 'expiresOn' | 'isComplete' | 'fieldStatuses' | 'createdAt' | 'updatedAt' | 'deletedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' }) id!: string
  @Property({ name: 'tenant_id', type: 'uuid' }) tenantId!: string
  @Property({ name: 'organization_id', type: 'uuid' }) organizationId!: string
  @Property({ name: 'person_id', type: 'uuid' }) personId!: string
  @Property({ type: 'text', nullable: true }) pesel?: string | null
  @Property({ name: 'document_type', type: 'text', nullable: true }) documentType?: IdentityDocumentType | string | null
  @Property({ name: 'issuing_country_code', type: 'text', nullable: true }) issuingCountryCode?: string | null
  @Property({ name: 'document_number', type: 'text', nullable: true }) documentNumber?: string | null
  @Property({ name: 'issued_on', type: 'text', nullable: true }) issuedOn?: string | null
  @Property({ name: 'expires_on', type: 'text', nullable: true }) expiresOn?: string | null
  @Property({ name: 'is_complete', type: 'boolean', default: false }) isComplete: boolean = false
  @Property({ name: 'field_statuses', type: 'json' }) fieldStatuses: IdentityFieldStatuses = { ...EMPTY_IDENTITY_FIELD_STATUSES }
  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() }) createdAt: Date = new Date()
  @Property({ name: 'updated_at', type: Date, onCreate: () => new Date(), onUpdate: () => new Date() }) updatedAt: Date = new Date()
  @Property({ name: 'deleted_at', type: Date, nullable: true }) deletedAt?: Date | null
}

export type FinooIdentityImportConflictState = 'open' | 'resolved' | 'dismissed'

@Entity({ tableName: 'finoo_identity_import_conflicts' })
@Index({
  name: 'finoo_identity_import_conflicts_open_source_uq',
  expression: `create unique index "finoo_identity_import_conflicts_open_source_uq" on "finoo_identity_import_conflicts" ("tenant_id", "organization_id", "source_module", "source_record_id", "candidate_digest") where "state" = 'open'`,
})
@Index({
  name: 'finoo_identity_import_conflicts_person_idx',
  properties: ['tenantId', 'organizationId', 'personId', 'state', 'createdAt'],
})
@Check({ name: 'finoo_identity_import_conflicts_state_chk', expression: `"state" in ('open', 'resolved', 'dismissed')` })
export class FinooIdentityImportConflict {
  [OptionalProps]?: 'candidatePesel' | 'candidateDocumentType' | 'candidateIssuingCountryCode' | 'candidateDocumentNumber' | 'candidateIssuedOn' | 'candidateExpiresOn' | 'state' | 'resolvedAt' | 'createdAt' | 'updatedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' }) id!: string
  @Property({ name: 'tenant_id', type: 'uuid' }) tenantId!: string
  @Property({ name: 'organization_id', type: 'uuid' }) organizationId!: string
  @Property({ name: 'person_id', type: 'uuid' }) personId!: string
  @Property({ name: 'source_module', type: 'text' }) sourceModule!: string
  @Property({ name: 'source_record_id', type: 'uuid' }) sourceRecordId!: string
  @Property({ name: 'candidate_digest', type: 'text' }) candidateDigest!: string
  @Property({ name: 'candidate_pesel', type: 'text', nullable: true }) candidatePesel?: string | null
  @Property({ name: 'candidate_document_type', type: 'text', nullable: true }) candidateDocumentType?: IdentityDocumentType | string | null
  @Property({ name: 'candidate_issuing_country_code', type: 'text', nullable: true }) candidateIssuingCountryCode?: string | null
  @Property({ name: 'candidate_document_number', type: 'text', nullable: true }) candidateDocumentNumber?: string | null
  @Property({ name: 'candidate_issued_on', type: 'text', nullable: true }) candidateIssuedOn?: string | null
  @Property({ name: 'candidate_expires_on', type: 'text', nullable: true }) candidateExpiresOn?: string | null
  @Property({ name: 'changed_fields', type: 'text[]' }) changedFields!: string[]
  @Property({ type: 'text', default: 'open' }) state: FinooIdentityImportConflictState = 'open'
  @Property({ name: 'resolved_at', type: Date, nullable: true }) resolvedAt?: Date | null
  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() }) createdAt: Date = new Date()
  @Property({ name: 'updated_at', type: Date, onCreate: () => new Date(), onUpdate: () => new Date() }) updatedAt: Date = new Date()
}

export type FinooIdentityAuditActorKind = 'user' | 'system'
export type FinooIdentityAuditOutcome = 'allowed' | 'denied'
export type FinooIdentityAuditOperation = 'read' | 'create' | 'update' | 'import' | 'review_conflict' | 'resolve_conflict' | 'dismiss_conflict' | 'erase' | 'denied'

@Entity({ tableName: 'finoo_identity_audit_entries' })
@Index({
  name: 'finoo_identity_audit_person_idx',
  properties: ['tenantId', 'organizationId', 'personId', 'createdAt'],
})
@Index({ name: 'finoo_identity_audit_actor_idx', properties: ['tenantId', 'actorUserId', 'createdAt'] })
@Check({ name: 'finoo_identity_audit_actor_kind_chk', expression: `"actor_kind" in ('user', 'system')` })
@Check({ name: 'finoo_identity_audit_outcome_chk', expression: `"outcome" in ('allowed', 'denied')` })
export class FinooIdentityAuditEntry {
  [OptionalProps]?: 'actorUserId' | 'personId' | 'changedFields' | 'createdAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' }) id!: string
  @Property({ name: 'tenant_id', type: 'uuid' }) tenantId!: string
  @Property({ name: 'organization_id', type: 'uuid' }) organizationId!: string
  @Property({ name: 'actor_user_id', type: 'uuid', nullable: true }) actorUserId?: string | null
  @Property({ name: 'actor_kind', type: 'text' }) actorKind!: FinooIdentityAuditActorKind
  @Property({ name: 'person_id', type: 'uuid', nullable: true }) personId?: string | null
  @Property({ name: 'subject_digest', type: 'text' }) subjectDigest!: string
  @Property({ type: 'text' }) operation!: FinooIdentityAuditOperation
  @Property({ type: 'text' }) outcome!: FinooIdentityAuditOutcome
  @Property({ name: 'changed_fields', type: 'text[]', nullable: true }) changedFields?: string[] | null
  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() }) createdAt: Date = new Date()
}
