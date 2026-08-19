import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { findOneWithDecryption, findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { encryptCustomFieldValue } from '@open-mercato/shared/lib/encryption/customFieldValues'
import { decryptWithAesGcm, decryptWithAesGcmStrict, hashForLookup } from '@open-mercato/shared/lib/encryption/aes'
import type { TenantDataEncryptionService } from '@open-mercato/shared/lib/encryption/tenantDataEncryptionService'
import type { ModuleCli } from '@open-mercato/shared/modules/registry'
import { CustomFieldDef, CustomFieldValue } from '@open-mercato/core/modules/entities/data/entities'
import { CustomerCompanyProfile, CustomerEntity, CustomerPersonProfile } from '@open-mercato/core/modules/customers/data/entities'
import { FinooApplicationIdentityBinding, FinooApplicationIntake } from './data/entities'
import { getFinooApplicationQueue } from './lib/queue'
import { hasConfiguredLookupHashPepper } from './lib/security'
import { FINOO_APPLICATION_SENSITIVE_FIELD_SPECS } from './lib/sensitive-fields'

const ENCRYPTED_VALUE_PATTERN = /^[^:]+:[^:]+:[^:]+:v1$/

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

const prepareEncryption: ModuleCli = {
  command: 'prepare-encryption',
  async run(args) {
    const tenantId = option(args, 'tenant')
    const organizationId = option(args, 'organization')
    const apply = args.includes('--apply')
    const dryRun = args.includes('--dry-run')
    const confirm = option(args, 'confirm')
    if (!tenantId || !organizationId || apply === dryRun || (apply && confirm !== tenantId)) {
      console.error('Usage: mercato finoo_applications prepare-encryption --tenant <id> --organization <id> (--dry-run|--apply --confirm <same-tenant-id>)')
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
      const definitionsWhere = FINOO_APPLICATION_SENSITIVE_FIELD_SPECS.map(({ entityId, key, kind }) => ({ entityId, key, kind }))
      const valuesWhere = FINOO_APPLICATION_SENSITIVE_FIELD_SPECS.map(({ entityId, key }) => ({ entityId, fieldKey: key }))
      const defs = await em.find(CustomFieldDef, { ...scope, $or: definitionsWhere, isActive: true, deletedAt: null })
      const missing = FINOO_APPLICATION_SENSITIVE_FIELD_SPECS
        .filter((spec) => !defs.some((def) => def.entityId === spec.entityId && def.key === spec.key && def.kind === spec.kind))
        .map(({ entityId, key, kind }) => `${entityId}:${key}:${kind}`)
      const rows = await em.find(CustomFieldValue, { ...scope, $or: valuesWhere, deletedAt: null })
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
      const identityCandidates = rows
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
        plaintextRows: plaintextRows.length,
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
      console.log(JSON.stringify({ ok: true, ...result }))
    } finally {
      await (container as unknown as { dispose?: () => Promise<void> }).dispose?.()
    }
  },
}

const commands = [replay, prepareEncryption]

export default commands
