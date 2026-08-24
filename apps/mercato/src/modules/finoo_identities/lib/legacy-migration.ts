import { LockMode } from '@mikro-orm/core'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { TenantDataEncryptionService } from '@open-mercato/shared/lib/encryption/tenantDataEncryptionService'
import { decryptWithAesGcmStrict, hashForLookup } from '@open-mercato/shared/lib/encryption/aes'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { CustomFieldDef } from '@open-mercato/core/modules/entities/data/entities'
import { markDefinitionTombstoned } from '@open-mercato/core/modules/entities/lib/definition-scope'
import {
  FinooIdentityAuditEntry,
  FinooPersonIdentity,
} from '../data/entities'
import { defaultEncryptionMaps } from '../encryption'
import { computeIdentityCompleteness, validatePesel } from './identity-domain'

export const LEGACY_IDENTITY_FIELD_KEYS = [
  'national_identification_number',
  'id_type',
  'id_country_code',
  'id_number',
  'id_issued_date',
  'id_expiry_date',
] as const

const RAW_ENCRYPTED_LEGACY_KEYS = new Set<string>([
  'national_identification_number',
  'id_number',
  'id_issued_date',
  'id_expiry_date',
])
const ENCRYPTED_VALUE_PATTERN = /^[^:]+:[^:]+:[^:]+:v1$/
const PERSON_PROFILE_ENTITY_ID = 'customers:customer_person_profile'

export type LegacyIdentityScope = { tenantId: string; organizationId: string }
export type LegacyIdentityMigrationMode = 'dry-run' | 'apply'
export type LegacyIdentityMigrationReport = {
  mode: LegacyIdentityMigrationMode
  scanned: number
  eligible: number
  wouldCreate: number
  created: number
  unchanged: number
  destinationConflicts: number
  invalidPesel: number
  unknownDocumentType: number
  unknownCountry: number
  invalidIssuedOn: number
  invalidExpiresOn: number
}

export type LegacyIdentityVerificationReport = {
  scanned: number
  migrated: number
  unmigrated: number
  destinationConflicts: number
  activeDefinitions: number
  inactiveDefinitions: number
}

type CandidateProfile = { profile_id: string; person_id: string }
type LegacyValueRow = {
  field_key: string
  value_text: unknown
  value_multiline: unknown
  value_int: unknown
  value_float: unknown
  value_bool: unknown
}
type LegacyValues = {
  pesel: string | null
  documentType: string | null
  issuingCountryCode: string | null
  documentNumber: string | null
  issuedOn: string | null
  expiresOn: string | null
}

function emptyMigrationReport(mode: LegacyIdentityMigrationMode): LegacyIdentityMigrationReport {
  return {
    mode,
    scanned: 0,
    eligible: 0,
    wouldCreate: 0,
    created: 0,
    unchanged: 0,
    destinationConflicts: 0,
    invalidPesel: 0,
    unknownDocumentType: 0,
    unknownCountry: 0,
    invalidIssuedOn: 0,
    invalidExpiresOn: 0,
  }
}

function rawStoredValue(row: LegacyValueRow): unknown {
  if (row.value_multiline !== null && row.value_multiline !== undefined) return row.value_multiline
  if (row.value_text !== null && row.value_text !== undefined) return row.value_text
  if (row.value_int !== null && row.value_int !== undefined) return row.value_int
  if (row.value_float !== null && row.value_float !== undefined) return row.value_float
  if (row.value_bool !== null && row.value_bool !== undefined) return row.value_bool
  return null
}

function normalizeText(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const normalized = String(value).trim()
  return normalized.length > 0 ? normalized : null
}

function isValidIdentityDate(value: string | null): boolean {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

function mapLegacyDocumentType(value: string | null): string | null {
  if (!value) return null
  const normalized = value.trim().toLowerCase()
  if (['idenitity_card', 'identity_card', 'id_card', 'idcard'].includes(normalized)) return 'identity_card'
  if (normalized === 'passport') return 'passport'
  if (['digital_identity_card', 'digitcard', 'digital_card'].includes(normalized)) return 'digital_identity_card'
  if (['permanent_identity_card', 'permanent_id_card'].includes(normalized)) return 'permanent_identity_card'
  return null
}

async function requireMigrationEncryption(
  encryptionService: TenantDataEncryptionService,
  scope: LegacyIdentityScope,
): Promise<string> {
  if (!encryptionService.isEnabled()) throw new Error('identity_encryption_unavailable')
  const dek = await encryptionService.getDek(scope.tenantId)
  if (!dek?.key) throw new Error('identity_encryption_unavailable')
  for (const map of defaultEncryptionMaps) {
    const encryptedFields = await encryptionService.getEncryptedFieldNames(
      map.entityId,
      scope.tenantId,
      scope.organizationId,
    )
    if (!map.fields.every(({ field }) => encryptedFields.includes(field))) {
      throw new Error('identity_encryption_unavailable')
    }
  }
  return dek.key
}

async function listCandidateProfiles(
  em: EntityManager,
  scope: LegacyIdentityScope,
  afterProfileId: string | null,
  batchSize: number,
): Promise<CandidateProfile[]> {
  return em.getConnection().execute<CandidateProfile[]>(
    `select profile.id as profile_id, profile.entity_id as person_id
     from customer_people profile
     join customer_entities person
       on person.id = profile.entity_id
      and person.tenant_id = profile.tenant_id
      and person.organization_id = profile.organization_id
      and person.kind = 'person'
      and person.deleted_at is null
     where profile.tenant_id = ?
       and profile.organization_id = ?
       and (? is null or profile.id > ?)
       and exists (
         select 1
         from custom_field_values legacy
         where legacy.tenant_id = profile.tenant_id
           and legacy.organization_id = profile.organization_id
           and legacy.entity_id = ?
           and legacy.record_id = profile.id::text
           and legacy.field_key in (${LEGACY_IDENTITY_FIELD_KEYS.map(() => '?').join(', ')})
           and legacy.deleted_at is null
       )
     order by profile.id
     limit ?`,
    [
      scope.tenantId,
      scope.organizationId,
      afterProfileId,
      afterProfileId,
      PERSON_PROFILE_ENTITY_ID,
      ...LEGACY_IDENTITY_FIELD_KEYS,
      batchSize,
    ],
  )
}

async function readDictionaryValue(
  em: EntityManager,
  scope: LegacyIdentityScope,
  entryId: string | null,
): Promise<string | null> {
  if (!entryId) return null
  const rows = await em.getConnection().execute<Array<{ value: string; normalized_value: string }>>(
    `select value, normalized_value
     from dictionary_entries
     where id = ? and tenant_id = ? and organization_id = ?
     limit 1`,
    [entryId, scope.tenantId, scope.organizationId],
  )
  return normalizeText(rows[0]?.normalized_value ?? rows[0]?.value)
}

async function readLegacyValues(
  em: EntityManager,
  scope: LegacyIdentityScope,
  profileId: string,
  dekKey: string,
  lock: boolean,
): Promise<{ values: LegacyValues; diagnostics: Pick<LegacyIdentityMigrationReport, 'invalidPesel' | 'unknownDocumentType' | 'unknownCountry' | 'invalidIssuedOn' | 'invalidExpiresOn'> } | null> {
  const rows = await em.getConnection().execute<LegacyValueRow[]>(
    `select field_key, value_text, value_multiline, value_int, value_float, value_bool
     from custom_field_values
     where tenant_id = ? and organization_id = ? and entity_id = ? and record_id = ?
       and field_key in (${LEGACY_IDENTITY_FIELD_KEYS.map(() => '?').join(', ')})
       and deleted_at is null
     ${lock ? 'for update' : ''}`,
    [scope.tenantId, scope.organizationId, PERSON_PROFILE_ENTITY_ID, profileId, ...LEGACY_IDENTITY_FIELD_KEYS],
  )
  if (rows.length === 0) return null
  const decoded = new Map<string, string | null>()
  for (const row of rows) {
    const stored = rawStoredValue(row)
    if (stored === null || stored === undefined) {
      decoded.set(row.field_key, null)
      continue
    }
    if (typeof stored === 'string' && ENCRYPTED_VALUE_PATTERN.test(stored)) {
      decoded.set(row.field_key, normalizeText(decryptWithAesGcmStrict(stored, dekKey)))
      continue
    }
    if (RAW_ENCRYPTED_LEGACY_KEYS.has(row.field_key)) {
      throw new Error('legacy_identity_source_not_encrypted')
    }
    decoded.set(row.field_key, normalizeText(stored))
  }
  const pesel = decoded.get('national_identification_number') ?? null
  const documentTypeReference = decoded.get('id_type') ?? null
  const countryReference = decoded.get('id_country_code') ?? null
  const documentTypeValue = await readDictionaryValue(em, scope, documentTypeReference)
  const countryValue = await readDictionaryValue(em, scope, countryReference)
  const documentType = mapLegacyDocumentType(documentTypeValue)
  const issuingCountryCode = countryValue && /^[A-Za-z]{2}$/.test(countryValue)
    ? countryValue.toUpperCase()
    : null
  const issuedOn = decoded.get('id_issued_date') ?? null
  const expiresOn = decoded.get('id_expiry_date') ?? null
  return {
    values: {
      pesel,
      documentType,
      issuingCountryCode,
      documentNumber: decoded.get('id_number') ?? null,
      issuedOn,
      expiresOn,
    },
    diagnostics: {
      invalidPesel: pesel && !validatePesel(pesel).valid ? 1 : 0,
      unknownDocumentType: documentTypeReference && !documentType ? 1 : 0,
      unknownCountry: countryReference && !issuingCountryCode ? 1 : 0,
      invalidIssuedOn: issuedOn && !isValidIdentityDate(issuedOn) ? 1 : 0,
      invalidExpiresOn: expiresOn && !isValidIdentityDate(expiresOn) ? 1 : 0,
    },
  }
}

function identityValuesEqual(identity: FinooPersonIdentity, values: LegacyValues): boolean {
  return identity.pesel === values.pesel
    && identity.documentType === values.documentType
    && identity.issuingCountryCode === values.issuingCountryCode
    && identity.documentNumber === values.documentNumber
    && identity.issuedOn === values.issuedOn
    && identity.expiresOn === values.expiresOn
}

async function processCandidate(
  em: EntityManager,
  encryptionKey: string,
  scope: LegacyIdentityScope,
  candidate: CandidateProfile,
  mode: LegacyIdentityMigrationMode,
  report: LegacyIdentityMigrationReport,
): Promise<void> {
  if (mode === 'apply') {
    await em.getConnection().execute(
      'select pg_advisory_xact_lock(hashtext(?))',
      [`finoo_identity:${scope.tenantId}:${scope.organizationId}:${candidate.person_id}`],
    )
  }
  const legacy = await readLegacyValues(em, scope, candidate.profile_id, encryptionKey, mode === 'apply')
  if (!legacy) return
  report.scanned += 1
  report.eligible += 1
  report.invalidPesel += legacy.diagnostics.invalidPesel
  report.unknownDocumentType += legacy.diagnostics.unknownDocumentType
  report.unknownCountry += legacy.diagnostics.unknownCountry
  report.invalidIssuedOn += legacy.diagnostics.invalidIssuedOn
  report.invalidExpiresOn += legacy.diagnostics.invalidExpiresOn
  const identity = await findOneWithDecryption(
    em,
    FinooPersonIdentity,
    { ...scope, personId: candidate.person_id, deletedAt: null },
    mode === 'apply' ? { lockMode: LockMode.PESSIMISTIC_WRITE } : undefined,
    scope,
  )
  if (identity) {
    if (identityValuesEqual(identity, legacy.values)) report.unchanged += 1
    else report.destinationConflicts += 1
    return
  }
  if (mode === 'dry-run') {
    report.wouldCreate += 1
    return
  }
  const completeness = computeIdentityCompleteness(legacy.values)
  em.persist(em.create(FinooPersonIdentity, {
    ...scope,
    personId: candidate.person_id,
    ...legacy.values,
    isComplete: completeness.isComplete,
    fieldStatuses: completeness.statuses,
  }))
  em.persist(em.create(FinooIdentityAuditEntry, {
    ...scope,
    actorUserId: null,
    actorKind: 'system',
    personId: candidate.person_id,
    subjectDigest: hashForLookup(
      candidate.person_id,
      `finoo_identity_audit:${scope.tenantId}:${scope.organizationId}`,
    ),
    operation: 'import',
    outcome: 'allowed',
    changedFields: ['pesel', 'documentType', 'issuingCountryCode', 'documentNumber', 'issuedOn', 'expiresOn'],
  }))
  report.created += 1
}

export async function migrateLegacyIdentities(input: {
  em: EntityManager
  encryptionService: TenantDataEncryptionService
  scope: LegacyIdentityScope
  mode: LegacyIdentityMigrationMode
  batchSize?: number
}): Promise<LegacyIdentityMigrationReport> {
  const batchSize = Math.min(Math.max(input.batchSize ?? 100, 1), 500)
  const encryptionKey = await requireMigrationEncryption(input.encryptionService, input.scope)
  const report = emptyMigrationReport(input.mode)
  let cursor: string | null = null
  while (true) {
    const candidates = await listCandidateProfiles(input.em, input.scope, cursor, batchSize)
    if (candidates.length === 0) break
    if (input.mode === 'apply') {
      await input.em.transactional(async (transactionalEm) => {
        for (const candidate of candidates) {
          await processCandidate(transactionalEm, encryptionKey, input.scope, candidate, input.mode, report)
        }
        await transactionalEm.flush()
      })
    } else {
      for (const candidate of candidates) {
        await processCandidate(input.em, encryptionKey, input.scope, candidate, input.mode, report)
      }
    }
    cursor = candidates[candidates.length - 1].profile_id
  }
  return report
}

export async function verifyLegacyIdentityMigration(
  em: EntityManager,
  encryptionService: TenantDataEncryptionService,
  scope: LegacyIdentityScope,
  batchSize = 500,
): Promise<LegacyIdentityVerificationReport> {
  const encryptionKey = await requireMigrationEncryption(encryptionService, scope)
  const migrationReport = emptyMigrationReport('dry-run')
  const report: LegacyIdentityVerificationReport = {
    scanned: 0,
    migrated: 0,
    unmigrated: 0,
    destinationConflicts: 0,
    activeDefinitions: 0,
    inactiveDefinitions: 0,
  }
  let cursor: string | null = null
  while (true) {
    const candidates = await listCandidateProfiles(em, scope, cursor, Math.min(Math.max(batchSize, 1), 500))
    if (candidates.length === 0) break
    for (const candidate of candidates) {
      await processCandidate(em, encryptionKey, scope, candidate, 'dry-run', migrationReport)
    }
    cursor = candidates[candidates.length - 1].profile_id
  }
  report.scanned = migrationReport.scanned
  report.migrated = migrationReport.unchanged
  report.unmigrated = migrationReport.wouldCreate
  report.destinationConflicts = migrationReport.destinationConflicts
  const definitions = await em.find(CustomFieldDef, {
    ...scope,
    entityId: PERSON_PROFILE_ENTITY_ID,
    key: { $in: [...LEGACY_IDENTITY_FIELD_KEYS] },
  }, { fields: ['id', 'key', 'isActive', 'deletedAt'] })
  report.activeDefinitions = definitions.filter((definition) => definition.isActive && !definition.deletedAt).length
  report.inactiveDefinitions = definitions.length - report.activeDefinitions
  return report
}

export async function setLegacyIdentityCutover(input: {
  em: EntityManager
  encryptionService: TenantDataEncryptionService
  scope: LegacyIdentityScope
  active: boolean
}): Promise<{ changedDefinitions: number; activeDefinitions: number }> {
  if (!input.active) {
    const verification = await verifyLegacyIdentityMigration(input.em, input.encryptionService, input.scope)
    if (verification.unmigrated > 0) throw new Error('legacy_identity_migration_incomplete')
    if (verification.destinationConflicts > 0) throw new Error('legacy_identity_destination_conflicts')
  }
  return input.em.transactional(async (transactionalEm) => {
    const definitions = await transactionalEm.find(CustomFieldDef, {
      ...input.scope,
      entityId: PERSON_PROFILE_ENTITY_ID,
      key: { $in: [...LEGACY_IDENTITY_FIELD_KEYS] },
    }, { lockMode: LockMode.PESSIMISTIC_WRITE })
    const byKey = new Map(definitions.map((definition) => [definition.key, definition]))
    if (LEGACY_IDENTITY_FIELD_KEYS.some((key) => !byKey.has(key))) {
      throw new Error('legacy_identity_definition_missing')
    }
    if (input.active) {
      const cutoverAt = definitions.map((definition) => definition.deletedAt?.getTime() ?? 0).sort((a, b) => b - a)[0]
      if (cutoverAt > 0) {
        const edits = await transactionalEm.count(FinooIdentityAuditEntry, {
          ...input.scope,
          createdAt: { $gt: new Date(cutoverAt) },
          operation: { $in: ['create', 'update', 'import', 'resolve_conflict'] },
          outcome: 'allowed',
        })
        if (edits > 0) throw new Error('manual_reconciliation_required')
      }
    }
    let changedDefinitions = 0
    for (const key of LEGACY_IDENTITY_FIELD_KEYS) {
      const definition = byKey.get(key)!
      if (input.active) {
        if (definition.isActive && !definition.deletedAt) continue
        definition.isActive = true
        definition.deletedAt = null
        definition.updatedAt = new Date()
      } else {
        if (!definition.isActive && definition.deletedAt) continue
        markDefinitionTombstoned(definition)
      }
      transactionalEm.persist(definition)
      changedDefinitions += 1
    }
    await transactionalEm.flush()
    return {
      changedDefinitions,
      activeDefinitions: input.active ? LEGACY_IDENTITY_FIELD_KEYS.length : 0,
    }
  })
}

export async function purgeLegacyIdentityFields(input: {
  em: EntityManager
  encryptionService: TenantDataEncryptionService
  scope: LegacyIdentityScope
  mode: LegacyIdentityMigrationMode
  batchSize?: number
}): Promise<{ mode: LegacyIdentityMigrationMode; values: number; definitions: number }> {
  const verification = await verifyLegacyIdentityMigration(input.em, input.encryptionService, input.scope)
  if (verification.activeDefinitions > 0) throw new Error('legacy_identity_cutover_required')
  if (verification.unmigrated > 0) throw new Error('legacy_identity_migration_incomplete')
  if (verification.destinationConflicts > 0) throw new Error('legacy_identity_destination_conflicts')
  if (verification.inactiveDefinitions !== LEGACY_IDENTITY_FIELD_KEYS.length) {
    throw new Error('legacy_identity_definition_missing')
  }
  const countRows = await input.em.getConnection().execute<Array<{ count: string | number }>>(
    `select count(*) as count
     from custom_field_values
     where tenant_id = ? and organization_id = ? and entity_id = ?
       and field_key in (${LEGACY_IDENTITY_FIELD_KEYS.map(() => '?').join(', ')})`,
    [input.scope.tenantId, input.scope.organizationId, PERSON_PROFILE_ENTITY_ID, ...LEGACY_IDENTITY_FIELD_KEYS],
  )
  const values = Number(countRows[0]?.count ?? 0)
  const definitions = verification.inactiveDefinitions
  if (input.mode === 'dry-run') return { mode: input.mode, values, definitions }
  const batchSize = Math.min(Math.max(input.batchSize ?? 500, 1), 1000)
  await input.em.transactional(async (transactionalEm) => {
    while (true) {
      const deleted = await transactionalEm.getConnection().execute<Array<{ id: string }>>(
        `delete from custom_field_values
         where id in (
           select id from custom_field_values
           where tenant_id = ? and organization_id = ? and entity_id = ?
             and field_key in (${LEGACY_IDENTITY_FIELD_KEYS.map(() => '?').join(', ')})
           limit ?
         )
         returning id`,
        [
          input.scope.tenantId,
          input.scope.organizationId,
          PERSON_PROFILE_ENTITY_ID,
          ...LEGACY_IDENTITY_FIELD_KEYS,
          batchSize,
        ],
      )
      if (deleted.length < batchSize) break
    }
    await transactionalEm.getConnection().execute(
      `delete from custom_field_defs
       where tenant_id = ? and organization_id = ? and entity_id = ?
         and "key" in (${LEGACY_IDENTITY_FIELD_KEYS.map(() => '?').join(', ')})`,
      [input.scope.tenantId, input.scope.organizationId, PERSON_PROFILE_ENTITY_ID, ...LEGACY_IDENTITY_FIELD_KEYS],
    )
  })
  return { mode: input.mode, values, definitions }
}
