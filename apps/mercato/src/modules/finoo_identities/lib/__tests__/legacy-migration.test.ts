import { encryptWithAesGcm, generateDek } from '@open-mercato/shared/lib/encryption/aes'
import { FinooIdentityAuditEntry, FinooPersonIdentity } from '../../data/entities'
import {
  LEGACY_IDENTITY_FIELD_KEYS,
  migrateLegacyIdentities,
  purgeLegacyIdentityFields,
  setLegacyIdentityCutover,
} from '../legacy-migration'

const findOneWithDecryption = jest.fn()

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: (...args: unknown[]) => findOneWithDecryption(...args),
}))

const tenantId = '5164d495-1865-4738-b459-2783999a761d'
const organizationId = 'd0d98cb3-28cf-4376-a61c-d270020f166f'
const profileId = 'f15fc8f6-a97e-4f13-8970-069e14e7f237'
const personId = 'ee823a18-e50c-4de4-9d71-4f516d7d754e'
const documentTypeEntryId = '1dc885ce-a2ce-4053-a069-e27ae0942327'
const countryEntryId = 'b46b303f-622a-4401-8e4c-c25895828164'

function encrypted(value: string, key: string): string {
  const result = encryptWithAesGcm(value, key).value
  if (!result) throw new Error('Expected encrypted fixture')
  return result
}

function migrationEncryptionService() {
  const key = generateDek()
  return {
    isEnabled: jest.fn(() => true),
    getDek: jest.fn(async () => ({ key })),
    getEncryptedFieldNames: jest.fn(async (entityId: string) => entityId.endsWith('finoo_person_identity')
      ? ['pesel', 'document_type', 'issuing_country_code', 'document_number', 'issued_on', 'expires_on']
      : ['candidate_pesel', 'candidate_document_type', 'candidate_issuing_country_code', 'candidate_document_number', 'candidate_issued_on', 'candidate_expires_on']),
  }
}

function buildFixture(mode: 'dry-run' | 'apply', existingIdentity: Record<string, unknown> | null = null) {
  const key = generateDek()
  let candidatePage = 0
  const persisted: unknown[] = []
  const execute = jest.fn(async (query: string, params?: unknown[]) => {
    if (query.includes('from customer_people profile')) {
      candidatePage += 1
      return candidatePage === 1 ? [{ profile_id: profileId, person_id: personId }] : []
    }
    if (query.includes('from custom_field_values')) {
      return [
        { field_key: 'national_identification_number', value_text: encrypted('44051401458', key), value_multiline: null, value_int: null, value_float: null, value_bool: null },
        { field_key: 'id_type', value_text: documentTypeEntryId, value_multiline: null, value_int: null, value_float: null, value_bool: null },
        { field_key: 'id_country_code', value_text: countryEntryId, value_multiline: null, value_int: null, value_float: null, value_bool: null },
        { field_key: 'id_number', value_text: encrypted('ABC123456', key), value_multiline: null, value_int: null, value_float: null, value_bool: null },
        { field_key: 'id_issued_date', value_text: encrypted('2024-01-10', key), value_multiline: null, value_int: null, value_float: null, value_bool: null },
        { field_key: 'id_expiry_date', value_text: encrypted('2034-01-10', key), value_multiline: null, value_int: null, value_float: null, value_bool: null },
      ]
    }
    if (query.includes('from dictionary_entries')) {
      return params?.[0] === documentTypeEntryId
        ? [{ value: 'Identity card', normalized_value: 'idenitity_card' }]
        : [{ value: 'Poland', normalized_value: 'pl' }]
    }
    if (query.includes('pg_advisory_xact_lock')) return []
    throw new Error(`Unexpected SQL: ${query}`)
  })
  const em: Record<string, unknown> = {
    getConnection: () => ({ execute }),
    create: (entity: unknown, data: Record<string, unknown>) => ({
      entity,
      id: entity === FinooPersonIdentity ? '4e5f6a45-e7fd-40df-85b5-ad8a6e82d5b5' : 'audit-entry-id',
      ...data,
    }),
    persist: (entity: unknown) => persisted.push(entity),
    flush: jest.fn(async () => undefined),
  }
  em.transactional = async (callback: (transactionalEm: unknown) => Promise<unknown>) => callback(em)
  findOneWithDecryption.mockResolvedValue(existingIdentity)
  const encryptionService = {
    isEnabled: jest.fn(() => true),
    getDek: jest.fn(async () => ({ key })),
    getEncryptedFieldNames: jest.fn(async (entityId: string) => entityId.endsWith('finoo_person_identity')
      ? ['pesel', 'document_type', 'issuing_country_code', 'document_number', 'issued_on', 'expires_on']
      : ['candidate_pesel', 'candidate_document_type', 'candidate_issuing_country_code', 'candidate_document_number', 'candidate_issued_on', 'candidate_expires_on']),
  }
  return { em, encryptionService, persisted, execute, mode }
}

describe('FINOO legacy identity migration', () => {
  beforeEach(() => findOneWithDecryption.mockReset())

  it('produces a count-only dry-run and performs no writes', async () => {
    const fixture = buildFixture('dry-run')
    const report = await migrateLegacyIdentities({
      em: fixture.em as never,
      encryptionService: fixture.encryptionService as never,
      scope: { tenantId, organizationId },
      mode: fixture.mode,
      batchSize: 10,
    })

    expect(report).toMatchObject({
      mode: 'dry-run', scanned: 1, eligible: 1, wouldCreate: 1, created: 0, destinationConflicts: 0,
    })
    expect(fixture.persisted).toHaveLength(0)
    expect(JSON.stringify(report)).not.toContain('44051401458')
    expect(JSON.stringify(report)).not.toContain(personId)
  })

  it('creates one encrypted-destination entity and a value-free audit in apply mode', async () => {
    const fixture = buildFixture('apply')
    const report = await migrateLegacyIdentities({
      em: fixture.em as never,
      encryptionService: fixture.encryptionService as never,
      scope: { tenantId, organizationId },
      mode: fixture.mode,
      batchSize: 10,
    })

    expect(report).toMatchObject({ mode: 'apply', created: 1, wouldCreate: 0 })
    expect(fixture.persisted).toHaveLength(2)
    expect(fixture.persisted[0]).toMatchObject({
      entity: FinooPersonIdentity,
      personId,
      pesel: '44051401458',
      documentType: 'identity_card',
      issuingCountryCode: 'PL',
      documentNumber: 'ABC123456',
      isComplete: true,
    })
    expect(fixture.persisted[1]).toMatchObject({
      entity: FinooIdentityAuditEntry,
      operation: 'import',
      outcome: 'allowed',
    })
    expect(JSON.stringify(fixture.persisted[1])).not.toContain('44051401458')
    expect(fixture.execute).toHaveBeenCalledWith(
      'select pg_advisory_xact_lock(hashtext(?))',
      [`finoo_identity:${tenantId}:${organizationId}:${personId}`],
    )
  })

  it('is idempotent and does not overwrite an identical active destination', async () => {
    const fixture = buildFixture('apply', {
      pesel: '44051401458',
      documentType: 'identity_card',
      issuingCountryCode: 'PL',
      documentNumber: 'ABC123456',
      issuedOn: '2024-01-10',
      expiresOn: '2034-01-10',
    })
    const report = await migrateLegacyIdentities({
      em: fixture.em as never,
      encryptionService: fixture.encryptionService as never,
      scope: { tenantId, organizationId },
      mode: fixture.mode,
    })

    expect(report).toMatchObject({ unchanged: 1, created: 0, destinationConflicts: 0 })
    expect(fixture.persisted).toHaveLength(0)
  })

  it.each(['cutover', 'purge'] as const)('blocks %s when legacy and destination values conflict', async (operation) => {
    const fixture = buildFixture('dry-run', {
      pesel: '44051401458',
      documentType: 'identity_card',
      issuingCountryCode: 'PL',
      documentNumber: 'DIFFERENT123',
      issuedOn: '2024-01-10',
      expiresOn: '2034-01-10',
    })
    const definitions = LEGACY_IDENTITY_FIELD_KEYS.map((key) => ({
      id: `${key}-id`,
      key,
      isActive: operation === 'cutover',
      deletedAt: operation === 'cutover' ? null : new Date('2026-08-24T12:00:00.000Z'),
    }))
    fixture.em.find = jest.fn(async () => definitions)

    const action = operation === 'cutover'
      ? setLegacyIdentityCutover({
          em: fixture.em as never,
          encryptionService: fixture.encryptionService as never,
          scope: { tenantId, organizationId },
          active: false,
        })
      : purgeLegacyIdentityFields({
          em: fixture.em as never,
          encryptionService: fixture.encryptionService as never,
          scope: { tenantId, organizationId },
          mode: 'dry-run',
        })

    await expect(action).rejects.toThrow('legacy_identity_destination_conflicts')
    expect(fixture.persisted).toHaveLength(0)
  })

  it('tombstones all six legacy definitions only after verification finds no unmigrated Person', async () => {
    const definitions = LEGACY_IDENTITY_FIELD_KEYS.map((key) => ({
      id: `${key}-id`,
      key,
      isActive: true,
      deletedAt: null as Date | null,
      updatedAt: new Date('2026-08-24T10:00:00.000Z'),
    }))
    const persisted: unknown[] = []
    const em: Record<string, unknown> = {
      getConnection: () => ({ execute: jest.fn(async (query: string) => query.includes('from customer_people profile') ? [] : (() => { throw new Error(`Unexpected SQL: ${query}`) })()) }),
      find: jest.fn(async () => definitions),
      persist: (entity: unknown) => persisted.push(entity),
      flush: jest.fn(async () => undefined),
    }
    em.transactional = async (callback: (transactionalEm: unknown) => Promise<unknown>) => callback(em)

    const result = await setLegacyIdentityCutover({
      em: em as never,
      encryptionService: migrationEncryptionService() as never,
      scope: { tenantId, organizationId },
      active: false,
    })

    expect(result).toEqual({ changedDefinitions: 6, activeDefinitions: 0 })
    expect(persisted).toHaveLength(6)
    expect(definitions.every((definition) => !definition.isActive && definition.deletedAt instanceof Date)).toBe(true)
  })

  it('blocks rollback when identity writes occurred after cutover', async () => {
    const definitions = LEGACY_IDENTITY_FIELD_KEYS.map((key) => ({
      id: `${key}-id`,
      key,
      isActive: false,
      deletedAt: new Date('2026-08-24T12:00:00.000Z'),
      updatedAt: new Date('2026-08-24T12:00:00.000Z'),
    }))
    const em: Record<string, unknown> = {
      find: jest.fn(async () => definitions),
      count: jest.fn(async () => 1),
      persist: jest.fn(),
      flush: jest.fn(async () => undefined),
    }
    em.transactional = async (callback: (transactionalEm: unknown) => Promise<unknown>) => callback(em)

    await expect(setLegacyIdentityCutover({
      em: em as never,
      encryptionService: migrationEncryptionService() as never,
      scope: { tenantId, organizationId },
      active: true,
    })).rejects.toThrow('manual_reconciliation_required')
    expect(em.persist).not.toHaveBeenCalled()
  })

  it('reactivates all six legacy definitions idempotently when no post-cutover identity write exists', async () => {
    const definitions = LEGACY_IDENTITY_FIELD_KEYS.map((key) => ({
      id: `${key}-id`,
      key,
      isActive: false,
      deletedAt: new Date('2026-08-24T12:00:00.000Z'),
      updatedAt: new Date('2026-08-24T12:00:00.000Z'),
    }))
    const persist = jest.fn()
    const em: Record<string, unknown> = {
      find: jest.fn(async () => definitions),
      count: jest.fn(async () => 0),
      persist,
      flush: jest.fn(async () => undefined),
    }
    em.transactional = async (callback: (transactionalEm: unknown) => Promise<unknown>) => callback(em)
    const input = {
      em: em as never,
      encryptionService: migrationEncryptionService() as never,
      scope: { tenantId, organizationId },
      active: true,
    }

    await expect(setLegacyIdentityCutover(input)).resolves.toEqual({
      changedDefinitions: 6,
      activeDefinitions: 6,
    })
    await expect(setLegacyIdentityCutover(input)).resolves.toEqual({
      changedDefinitions: 0,
      activeDefinitions: 6,
    })
    expect(persist).toHaveBeenCalledTimes(6)
    expect(definitions.every((definition) => definition.isActive && definition.deletedAt === null)).toBe(true)
  })

  it('reports purge counts without deleting values in dry-run mode', async () => {
    const definitions = LEGACY_IDENTITY_FIELD_KEYS.map((key) => ({
      id: `${key}-id`,
      key,
      isActive: false,
      deletedAt: new Date('2026-08-24T12:00:00.000Z'),
    }))
    const execute = jest.fn(async (query: string) => {
      if (query.includes('from customer_people profile')) return []
      if (query.includes('select count(*) as count')) return [{ count: '9' }]
      throw new Error(`Unexpected SQL: ${query}`)
    })
    const em = {
      getConnection: () => ({ execute }),
      find: jest.fn(async () => definitions),
      transactional: jest.fn(),
    }

    const report = await purgeLegacyIdentityFields({
      em: em as never,
      encryptionService: migrationEncryptionService() as never,
      scope: { tenantId, organizationId },
      mode: 'dry-run',
    })

    expect(report).toEqual({
      mode: 'dry-run',
      values: 9,
      definitions: 6,
      residualValues: 9,
      residualDefinitions: 6,
    })
    expect(em.transactional).not.toHaveBeenCalled()
    expect(execute.mock.calls.some(([query]) => String(query).includes('delete from'))).toBe(false)
  })

  it('purges values in separately committed batches and proves zero residual rows', async () => {
    const definitions = LEGACY_IDENTITY_FIELD_KEYS.map((key) => ({
      id: `${key}-id`,
      key,
      isActive: false,
      deletedAt: new Date('2026-08-24T12:00:00.000Z'),
    }))
    let valueCount = 5
    let definitionCount = definitions.length
    const execute = jest.fn(async (query: string) => {
      if (query.includes('from customer_people profile')) return []
      if (query.includes('select count(*) as count') && query.includes('from custom_field_values')) {
        return [{ count: String(valueCount) }]
      }
      if (query.includes('delete from custom_field_values')) {
        const deletedCount = Math.min(valueCount, 2)
        valueCount -= deletedCount
        return Array.from({ length: deletedCount }, (_, index) => ({ id: `value-${valueCount}-${index}` }))
      }
      if (query.includes('delete from custom_field_defs')) {
        definitionCount = 0
        return []
      }
      if (query.includes('select count(*) as count') && query.includes('from custom_field_defs')) {
        return [{ count: String(definitionCount) }]
      }
      throw new Error(`Unexpected SQL: ${query}`)
    })
    const em: Record<string, unknown> = {
      getConnection: () => ({ execute }),
      find: jest.fn(async () => definitions),
    }
    em.transactional = jest.fn(async (callback: (transactionalEm: unknown) => Promise<unknown>) => callback(em))

    await expect(purgeLegacyIdentityFields({
      em: em as never,
      encryptionService: migrationEncryptionService() as never,
      scope: { tenantId, organizationId },
      mode: 'apply',
      batchSize: 2,
    })).resolves.toEqual({
      mode: 'apply',
      values: 5,
      definitions: 6,
      residualValues: 0,
      residualDefinitions: 0,
    })
    expect(em.transactional).toHaveBeenCalledTimes(4)
  })

  it('fails closed when post-purge read-back finds a residual definition', async () => {
    const definitions = LEGACY_IDENTITY_FIELD_KEYS.map((key) => ({
      id: `${key}-id`,
      key,
      isActive: false,
      deletedAt: new Date('2026-08-24T12:00:00.000Z'),
    }))
    let valueCount = 1
    const execute = jest.fn(async (query: string) => {
      if (query.includes('from customer_people profile')) return []
      if (query.includes('select count(*) as count') && query.includes('from custom_field_values')) {
        return [{ count: String(valueCount) }]
      }
      if (query.includes('delete from custom_field_values')) {
        valueCount = 0
        return [{ id: 'value-1' }]
      }
      if (query.includes('delete from custom_field_defs')) return []
      if (query.includes('select count(*) as count') && query.includes('from custom_field_defs')) {
        return [{ count: '1' }]
      }
      throw new Error(`Unexpected SQL: ${query}`)
    })
    const em: Record<string, unknown> = {
      getConnection: () => ({ execute }),
      find: jest.fn(async () => definitions),
    }
    em.transactional = async (callback: (transactionalEm: unknown) => Promise<unknown>) => callback(em)

    await expect(purgeLegacyIdentityFields({
      em: em as never,
      encryptionService: migrationEncryptionService() as never,
      scope: { tenantId, organizationId },
      mode: 'apply',
      batchSize: 2,
    })).rejects.toThrow('legacy_identity_purge_incomplete')
  })

  it('refuses purge when the legacy definition set is incomplete', async () => {
    const execute = jest.fn(async (query: string) => query.includes('from customer_people profile') ? [] : [])
    const em = {
      getConnection: () => ({ execute }),
      find: jest.fn(async () => LEGACY_IDENTITY_FIELD_KEYS.slice(0, 5).map((key) => ({
        id: `${key}-id`,
        key,
        isActive: false,
        deletedAt: new Date('2026-08-24T12:00:00.000Z'),
      }))),
    }

    await expect(purgeLegacyIdentityFields({
      em: em as never,
      encryptionService: migrationEncryptionService() as never,
      scope: { tenantId, organizationId },
      mode: 'dry-run',
    })).rejects.toThrow('legacy_identity_definition_missing')
  })
})
