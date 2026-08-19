import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { findOneWithDecryption, findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { encryptCustomFieldValue } from '@open-mercato/shared/lib/encryption/customFieldValues'
import { decryptWithAesGcm, decryptWithAesGcmStrict, encryptWithAesGcm, hashForLookup } from '@open-mercato/shared/lib/encryption/aes'
import type { TenantDataEncryptionService } from '@open-mercato/shared/lib/encryption/tenantDataEncryptionService'
import type { ModuleCli } from '@open-mercato/shared/modules/registry'
import { CustomFieldDef, CustomFieldValue, EncryptionMap } from '@open-mercato/core/modules/entities/data/entities'
import { CustomerCompanyProfile, CustomerEntity, CustomerPersonProfile } from '@open-mercato/core/modules/customers/data/entities'
import { FinooApplicationIdentityBinding, FinooApplicationIntake } from './data/entities'
import { getFinooApplicationQueue } from './lib/queue'
import { hasConfiguredLookupHashPepper } from './lib/security'
import { FINOO_APPLICATION_REQUIRED_ENCRYPTION_MAPS, FINOO_APPLICATION_SENSITIVE_FIELD_SPECS } from './lib/sensitive-fields'

const ENCRYPTED_VALUE_PATTERN = /^[^:]+:[^:]+:[^:]+:v1$/

type RequiredTableSpec = {
  entityId: string
  table: string
  fields: Array<{ column: string; json?: boolean }>
}

const REQUIRED_TABLE_SPECS: RequiredTableSpec[] = [
  {
    entityId: 'customers:customer_entity', table: 'customer_entities',
    fields: [
      { column: 'display_name' }, { column: 'primary_email' }, { column: 'primary_phone' },
      { column: 'next_interaction_name' }, { column: 'description' },
    ],
  },
  {
    entityId: 'customers:customer_person_profile', table: 'customer_people',
    fields: [
      { column: 'first_name' }, { column: 'last_name' }, { column: 'preferred_name' },
      { column: 'job_title' }, { column: 'department' }, { column: 'seniority' },
      { column: 'timezone' }, { column: 'linked_in_url' }, { column: 'twitter_url' },
    ],
  },
  {
    entityId: 'customers:customer_company_profile', table: 'customer_companies',
    fields: [
      { column: 'legal_name' }, { column: 'brand_name' }, { column: 'domain' },
      { column: 'website_url' }, { column: 'industry' },
    ],
  },
  {
    entityId: 'customers:customer_deal', table: 'customer_deals',
    fields: [{ column: 'title' }, { column: 'description' }],
  },
  {
    entityId: 'audit_logs:action_log', table: 'action_logs',
    fields: [
      { column: 'command_id' }, { column: 'action_label' },
      { column: 'command_payload', json: true }, { column: 'snapshot_before', json: true },
      { column: 'snapshot_after', json: true }, { column: 'changes_json', json: true },
      { column: 'context_json', json: true },
    ],
  },
  {
    entityId: 'finoo_applications:finoo_application_intake', table: 'finoo_application_intakes',
    fields: [{ column: 'payload_json', json: true }],
  },
]

type SqlConnection = { execute: (query: string, params?: unknown[]) => Promise<unknown> }

function assertSupportedMapFields(entityId: string, fields: Array<{ field: string }>): void {
  const tableSpec = REQUIRED_TABLE_SPECS.find((candidate) => candidate.entityId === entityId)
  const supportedFields = new Set(tableSpec?.fields.map(({ column }) => column) ?? [])
  const unsupported = fields.map(({ field }) => field).filter((field) => !supportedFields.has(field))
  if (unsupported.length) {
    throw new Error(`[internal] Existing encryption map has unsupported fields for FINOO backfill: ${entityId}`)
  }
}

function requiredMapFields(entityId: string): Array<{ field: string; hashField?: string | null }> {
  const spec = FINOO_APPLICATION_REQUIRED_ENCRYPTION_MAPS.find((candidate) => candidate.entityId === entityId)
  if (!spec) throw new Error('[internal] FINOO required encryption map is missing')
  return spec.fields.map((field) => ({ field }))
}

function encryptedValue(value: unknown, dek: string, json: boolean): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' && ENCRYPTED_VALUE_PATTERN.test(value)) {
    try {
      decryptWithAesGcmStrict(value, dek)
      return null
    } catch {
      throw new Error('[internal] Existing FINOO mapped-field ciphertext failed authentication')
    }
  }
  const serialized = typeof value === 'string' ? value : JSON.stringify(value)
  const ciphertext = encryptWithAesGcm(serialized, dek).value
  if (!ciphertext) throw new Error('[internal] FINOO mapped-field encryption failed closed')
  return json ? JSON.stringify(ciphertext) : ciphertext
}

async function prepareRequiredMappedFields(
  em: EntityManager,
  scope: { tenantId: string; organizationId: string },
  dek: string,
  apply: boolean,
): Promise<number> {
  const connection = em.getConnection() as unknown as SqlConnection
  let rowsToEncrypt = 0
  for (const spec of REQUIRED_TABLE_SPECS) {
    const columns = spec.fields.map(({ column }) => `"${column}"`).join(', ')
    const result = await connection.execute(
      `select "id", ${columns} from "${spec.table}" where tenant_id = ? and organization_id = ? for update`,
      [scope.tenantId, scope.organizationId],
    )
    const rows = Array.isArray(result) ? result as Array<Record<string, unknown>> : []
    for (const row of rows) {
      const updates: Array<{ column: string; value: string }> = []
      for (const field of spec.fields) {
        const next = encryptedValue(row[field.column], dek, field.json === true)
        if (next !== null) updates.push({ column: field.column, value: next })
      }
      if (!updates.length) continue
      rowsToEncrypt += 1
      if (!apply) continue
      await connection.execute(
        `update "${spec.table}" set ${updates.map(({ column }) => `"${column}" = ?`).join(', ')} where "id" = ?`,
        [...updates.map(({ value }) => value), row.id],
      )
    }
  }
  return rowsToEncrypt
}

async function requiredMapsToEnable(
  em: EntityManager,
  scope: { tenantId: string; organizationId: string },
): Promise<number> {
  const existing = await em.find(EncryptionMap, {
    ...scope,
    entityId: { $in: FINOO_APPLICATION_REQUIRED_ENCRYPTION_MAPS.map(({ entityId }) => entityId) },
    deletedAt: null,
  })
  return FINOO_APPLICATION_REQUIRED_ENCRYPTION_MAPS.filter((spec) => {
    const candidates = existing.filter((candidate) => candidate.entityId === spec.entityId)
    if (candidates.length > 1) throw new Error(`[internal] Duplicate scoped encryption maps: ${spec.entityId}`)
    const current = candidates[0]
    if (current?.fieldsJson) assertSupportedMapFields(spec.entityId, current.fieldsJson)
    const currentFields = new Set(Array.isArray(current?.fieldsJson) ? current.fieldsJson.map((field) => field.field) : [])
    return !current?.isActive || spec.fields.some((field) => !currentFields.has(field))
  }).length
}

async function enableRequiredMaps(
  em: EntityManager,
  scope: { tenantId: string; organizationId: string },
): Promise<void> {
  for (const spec of FINOO_APPLICATION_REQUIRED_ENCRYPTION_MAPS) {
    const candidates = await em.find(EncryptionMap, { ...scope, entityId: spec.entityId, deletedAt: null })
    if (candidates.length > 1) throw new Error(`[internal] Duplicate scoped encryption maps: ${spec.entityId}`)
    const current = candidates[0]
    if (current?.fieldsJson) assertSupportedMapFields(spec.entityId, current.fieldsJson)
    const fieldsJson = [...(current?.fieldsJson ?? [])]
    const currentFields = new Set(fieldsJson.map((field) => field.field))
    for (const rule of requiredMapFields(spec.entityId)) {
      if (!currentFields.has(rule.field)) fieldsJson.push(rule)
    }
    if (current) {
      current.fieldsJson = fieldsJson
      current.isActive = true
      em.persist(current)
      continue
    }
    em.persist(em.create(EncryptionMap, {
      ...scope, entityId: spec.entityId, fieldsJson, isActive: true, createdAt: new Date(), updatedAt: new Date(),
    }))
  }
}

function option(args: string[], name: string): string | null {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] ?? null : null
}

const replay: ModuleCli = {
  command: 'replay',
  async run(args) {
    const tenantId = option(args, 'tenant')
    const organizationId = option(args, 'organization')
    const intakeId = option(args, 'intake')
    const confirm = option(args, 'confirm')
    if (!tenantId || !organizationId || !intakeId || confirm !== intakeId) {
      console.error('Usage: mercato finoo_applications replay --tenant <id> --organization <id> --intake <id> --confirm <same-intake-id>')
      return
    }
    const container = await createRequestContainer()
    try {
      const em = (container.resolve('em') as EntityManager).fork()
      const scope = { tenantId, organizationId }
      const intake = await findOneWithDecryption(em, FinooApplicationIntake, { ...scope, id: intakeId }, undefined, scope)
      if (!intake) throw new Error('[internal] FINOO intake was not found in the requested scope')
      if (intake.state === 'processed') throw new Error('[internal] Processed FINOO intake cannot be replayed')
      intake.state = 'retrying'
      intake.nextAttemptAt = new Date()
      intake.leaseExpiresAt = null
      intake.lastErrorCode = null
      await em.flush()
      await getFinooApplicationQueue().enqueue({ intakeId, ...scope })
      console.log(JSON.stringify({ ok: true, intakeId }))
    } finally {
      await (container as unknown as { dispose?: () => Promise<void> }).dispose?.()
    }
  },
}

function rawCustomFieldValue(row: CustomFieldValue): unknown {
  if (row.valueMultiline !== null && row.valueMultiline !== undefined) return row.valueMultiline
  if (row.valueText !== null && row.valueText !== undefined) return row.valueText
  if (row.valueInt !== null && row.valueInt !== undefined) return row.valueInt
  if (row.valueFloat !== null && row.valueFloat !== undefined) return row.valueFloat
  if (row.valueBool !== null && row.valueBool !== undefined) return row.valueBool
  return null
}

function rawDeletedCustomFieldValue(row: Record<string, unknown>): unknown {
  for (const key of ['value_multiline', 'value_text', 'value_int', 'value_float', 'value_bool']) {
    if (row[key] !== null && row[key] !== undefined) return row[key]
  }
  return null
}

const prepareEncryption: ModuleCli = {
  command: 'prepare-encryption',
  async run(args) {
    const tenantId = option(args, 'tenant')
    const organizationId = option(args, 'organization')
    const apply = args.includes('--apply')
    const dryRun = args.includes('--dry-run')
    const maintenanceWindow = args.includes('--maintenance-window')
    const confirm = option(args, 'confirm')
    if (!tenantId || !organizationId || apply === dryRun || (apply && (confirm !== tenantId || !maintenanceWindow))) {
      console.error('Usage: mercato finoo_applications prepare-encryption --tenant <id> --organization <id> (--dry-run|--apply --maintenance-window --confirm <same-tenant-id>)')
      return
    }
    const container = await createRequestContainer()
    try {
      const em = (container.resolve('em') as EntityManager).fork()
      const scope = { tenantId, organizationId }
      const encryption = container.resolve('tenantEncryptionService') as TenantDataEncryptionService
      const dek = encryption.isEnabled() ? await encryption.getDek(tenantId) : null
      if (!dek?.key) throw new Error('[internal] Tenant encryption/DEK is unavailable')
      if (!hasConfiguredLookupHashPepper()) {
        throw new Error('[internal] Lookup-hash pepper is unavailable')
      }
      const coreRowsToEncrypt = await prepareRequiredMappedFields(em, scope, dek.key, false)
      const coreMapsToEnable = await requiredMapsToEnable(em, scope)
      const definitionsWhere = FINOO_APPLICATION_SENSITIVE_FIELD_SPECS.map(({ entityId, key, kind }) => ({ entityId, key, kind }))
      const valuesWhere = FINOO_APPLICATION_SENSITIVE_FIELD_SPECS.map(({ entityId, key }) => ({ entityId, fieldKey: key }))
      const defs = await em.find(CustomFieldDef, { ...scope, $or: definitionsWhere, isActive: true, deletedAt: null })
      const missing = FINOO_APPLICATION_SENSITIVE_FIELD_SPECS
        .filter((spec) => !defs.some((def) => def.entityId === spec.entityId && def.key === spec.key && def.kind === spec.kind))
        .map(({ entityId, key, kind }) => `${entityId}:${key}:${kind}`)
      const rows = await em.find(CustomFieldValue, { ...scope, $or: valuesWhere, deletedAt: null })
      const connection = em.getConnection() as unknown as SqlConnection
      const deletedResult = await connection.execute(
        `select id, entity_id, record_id, field_key, value_text, value_multiline, value_int, value_float, value_bool
         from custom_field_values where tenant_id = ? and organization_id = ? and deleted_at is not null`,
        [tenantId, organizationId],
      )
      const sensitivePairs = new Set(FINOO_APPLICATION_SENSITIVE_FIELD_SPECS.map(({ entityId, key }) => `${entityId}:${key}`))
      const deletedRows = (Array.isArray(deletedResult) ? deletedResult as Array<Record<string, unknown>> : [])
        .filter((row) => sensitivePairs.has(`${String(row.entity_id)}:${String(row.field_key)}`))
      const decodedRows = rows.map((row) => {
        const stored = rawCustomFieldValue(row)
        if (typeof stored !== 'string' || !ENCRYPTED_VALUE_PATTERN.test(stored)) {
          return { row, raw: stored, encrypted: false }
        }
        try {
          return { row, raw: decryptWithAesGcmStrict(stored, dek.key), encrypted: true }
        } catch {
          throw new Error('[internal] Existing FINOO custom-field ciphertext failed authentication')
        }
      })
      const plaintextRows = decodedRows.filter(({ raw, encrypted }) => raw !== null && !encrypted)
      const decodedDeletedRows = deletedRows.map((row) => {
        const stored = rawDeletedCustomFieldValue(row)
        if (typeof stored !== 'string' || !ENCRYPTED_VALUE_PATTERN.test(stored)) {
          return { row, raw: stored, encrypted: false }
        }
        try {
          return { row, raw: decryptWithAesGcmStrict(stored, dek.key), encrypted: true }
        } catch {
          throw new Error('[internal] Existing deleted FINOO custom-field ciphertext failed authentication')
        }
      })
      const plaintextDeletedRows = decodedDeletedRows.filter(({ raw, encrypted }) => raw !== null && !encrypted)
      const identityCandidates = rows
        .filter((row) => !row.deletedAt)
        .filter((row) => row.fieldKey === 'tax_number' || row.fieldKey === 'national_identification_number')
        .map((row) => {
          const decoded = decodedRows.find((candidate) => candidate.row === row)
          return { recordId: row.recordId, fieldKey: row.fieldKey, raw: decoded?.raw }
        })
      const bindingCandidates: Array<{ kind: 'nip' | 'pesel' | 'email'; raw: string; customerEntityId: string }> = []
      for (const row of identityCandidates) {
        if (typeof row.raw !== 'string' || !row.raw) continue
        if (row.fieldKey === 'tax_number') {
          const profile = await findOneWithDecryption(em, CustomerCompanyProfile, { ...scope, id: row.recordId }, { populate: ['entity'] }, scope)
          const normalized = row.raw.replace(/\D/g, '')
          if (profile && normalized.length === 10) bindingCandidates.push({ kind: 'nip', raw: normalized, customerEntityId: profile.entity.id })
        }
        if (row.fieldKey === 'national_identification_number') {
          const profile = await findOneWithDecryption(em, CustomerPersonProfile, { ...scope, id: row.recordId }, { populate: ['entity'] }, scope)
          const normalized = row.raw.replace(/\D/g, '')
          if (profile && normalized.length === 11) bindingCandidates.push({ kind: 'pesel', raw: normalized, customerEntityId: profile.entity.id })
        }
      }
      const people = await findWithDecryption(em, CustomerEntity, { ...scope, kind: 'person', deletedAt: null }, { orderBy: { id: 'asc' } }, scope)
      for (const person of people) {
        const normalized = person.primaryEmail?.trim().toLowerCase()
        if (normalized) bindingCandidates.push({ kind: 'email', raw: normalized, customerEntityId: person.id })
      }
      const groupedCandidates = new Map<string, typeof bindingCandidates>()
      for (const candidate of bindingCandidates) {
        const identityHash = hashForLookup(candidate.raw, `finoo_application:${tenantId}:${organizationId}:${candidate.kind}`)
        const key = `${candidate.kind}:${identityHash}`
        groupedCandidates.set(key, [...(groupedCandidates.get(key) ?? []), candidate])
      }
      const identityCollisions = [...groupedCandidates.entries()].flatMap(([key, candidates]) => {
        const customerEntityIds = [...new Set(candidates.map(({ customerEntityId }) => customerEntityId))]
        if (customerEntityIds.length < 2) return []
        const [kind, identityHash] = key.split(':', 2)
        return [{ kind, identityHash: identityHash.slice(0, 16), count: customerEntityIds.length }]
      })
      const result = {
        mode: apply ? 'apply' : 'dry-run',
        definitions: defs.length,
        missingDefinitions: missing,
        definitionsToEnable: defs.filter((def) => (def.configJson as Record<string, unknown> | null)?.encrypted !== true).length,
        plaintextRows: plaintextRows.length + plaintextDeletedRows.length,
        coreRowsToEncrypt,
        coreMapsToEnable,
        identityCollisions,
      }
      if (missing.length) throw new Error(`[internal] Missing FINOO custom-field definitions: ${missing.join(',')}`)
      if (dryRun) {
        console.log(JSON.stringify(result, null, 2))
        return
      }
      if (identityCollisions.length) {
        throw new Error(`[internal] FINOO identity collisions require manual resolution: ${identityCollisions.length}`)
      }
      await em.transactional(async (transactionalEm) => {
        await prepareRequiredMappedFields(transactionalEm, scope, dek.key, true)
        await enableRequiredMaps(transactionalEm, scope)
        for (const { row, raw } of plaintextRows) {
          const encrypted = await encryptCustomFieldValue(raw, tenantId, encryption)
          if (typeof encrypted !== 'string' || decryptWithAesGcm(encrypted, dek.key) === null) {
            throw new Error('[internal] Custom-field encryption failed closed')
          }
          row.valueText = encrypted
          row.valueMultiline = null
          row.valueInt = null
          row.valueFloat = null
          row.valueBool = null
          transactionalEm.persist(row)
        }
        const transactionalConnection = transactionalEm.getConnection() as unknown as SqlConnection
        for (const { row, raw } of plaintextDeletedRows) {
          const encrypted = await encryptCustomFieldValue(raw, tenantId, encryption)
          if (typeof encrypted !== 'string' || decryptWithAesGcm(encrypted, dek.key) === null) {
            throw new Error('[internal] Deleted custom-field encryption failed closed')
          }
          await transactionalConnection.execute(
            `update custom_field_values set value_text = ?, value_multiline = null, value_int = null,
               value_float = null, value_bool = null where id = ? and tenant_id = ? and organization_id = ?`,
            [encrypted, row.id, tenantId, organizationId],
          )
        }
        for (const def of defs) {
          const currentConfig = def.configJson && typeof def.configJson === 'object' ? def.configJson as Record<string, unknown> : {}
          def.configJson = { ...currentConfig, encrypted: true }
          transactionalEm.persist(def)
        }
        const bindExisting = async (kind: 'nip' | 'pesel' | 'email', raw: string, customerEntityId: string) => {
          const identityHash = hashForLookup(raw, `finoo_application:${tenantId}:${organizationId}:${kind}`)
          const existing = await findOneWithDecryption(transactionalEm, FinooApplicationIdentityBinding, { ...scope, identityKind: kind, identityHash }, undefined, scope)
          if (existing) {
            const boundEntityId = existing.customerEntityId ?? existing.reservedEntityId
            if (boundEntityId !== customerEntityId) {
              throw new Error('[internal] Existing FINOO identity binding conflicts with the CRM entity')
            }
            return
          }
          transactionalEm.persist(transactionalEm.create(FinooApplicationIdentityBinding, {
            ...scope, projectionId: null, identityKind: kind, identityHash,
            reservedEntityId: customerEntityId, customerEntityId,
          }))
        }
        for (const candidate of bindingCandidates) {
          await bindExisting(candidate.kind, candidate.raw, candidate.customerEntityId)
        }
        await transactionalEm.flush()
      })
      for (const { entityId } of FINOO_APPLICATION_REQUIRED_ENCRYPTION_MAPS) {
        await encryption.invalidateMap(entityId, tenantId, organizationId)
      }
      console.log(JSON.stringify({ ok: true, ...result }))
    } finally {
      await (container as unknown as { dispose?: () => Promise<void> }).dispose?.()
    }
  },
}

const commands = [replay, prepareEncryption]

export default commands
