import type { EntityManager } from '@mikro-orm/postgresql'
import { Dictionary, DictionaryEntry } from '@open-mercato/core/modules/dictionaries/data/entities'
import { CustomFieldDef, CustomFieldValue } from '../../data/entities'
import { backfillCustomFieldDictionaryEntries } from '../backfill-dictionary-entries'

function makeDef(overrides: Partial<CustomFieldDef>): CustomFieldDef {
  return Object.assign(new CustomFieldDef(), {
    id: `def-${overrides.entityId ?? 'entity'}-${overrides.key ?? 'field'}`,
    entityId: 'customers:customer_person_profile',
    organizationId: 'org-1',
    tenantId: 'tenant-1',
    key: 'industry_external',
    kind: 'select',
    configJson: { dictionaryId: 'dict-1' },
    isActive: true,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    deletedAt: null,
    ...overrides,
  })
}

function makeDictionary(overrides: Partial<Dictionary> = {}): Dictionary {
  return Object.assign(new Dictionary(), {
    id: 'dict-1',
    organizationId: 'org-1',
    tenantId: 'tenant-1',
    key: 'customer_industry_external',
    name: 'Customer industry external',
    isSystem: false,
    isActive: true,
    managerVisibility: 'default',
    createdAt: new Date(0),
    updatedAt: new Date(0),
    deletedAt: null,
    ...overrides,
  })
}

function makeValue(overrides: Partial<CustomFieldValue>): CustomFieldValue {
  return Object.assign(new CustomFieldValue(), {
    id: `value-${overrides.recordId ?? 'record'}`,
    entityId: 'customers:customer_person_profile',
    recordId: 'record-1',
    organizationId: 'org-1',
    tenantId: 'tenant-1',
    fieldKey: 'industry_external',
    valueText: 'Benefits',
    valueMultiline: null,
    valueInt: null,
    valueFloat: null,
    valueBool: null,
    createdAt: new Date(0),
    deletedAt: null,
    ...overrides,
  })
}

function makeEntry(overrides: Partial<DictionaryEntry> = {}): DictionaryEntry {
  return Object.assign(new DictionaryEntry(), {
    id: 'entry-1',
    dictionary: makeDictionary(),
    organizationId: 'org-1',
    tenantId: 'tenant-1',
    value: 'Benefits',
    normalizedValue: 'benefits',
    label: 'Existing label',
    color: '#abcdef',
    icon: 'briefcase',
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  })
}

function createEm(params: {
  defs?: CustomFieldDef[]
  dictionaries?: Dictionary[]
  values?: CustomFieldValue[]
  entries?: DictionaryEntry[]
}) {
  const persisted: unknown[] = []
  const defs = params.defs ?? []
  const dictionaries = params.dictionaries ?? []
  const values = params.values ?? []
  const entries = params.entries ?? []
  const em = {
    find: jest.fn(async (entity: unknown, where: Record<string, unknown>) => {
      if (entity === CustomFieldDef) return defs
      if (entity === Dictionary) return dictionaries
      if (entity === CustomFieldValue) return values
      if (entity === DictionaryEntry) {
        const dictionary = where.dictionary as Dictionary
        return entries.filter((entry) => entry.dictionary.id === dictionary.id)
      }
      return []
    }),
    create: jest.fn((_entity: unknown, payload: Record<string, unknown>) => ({
      id: `created-${persisted.length + 1}`,
      ...payload,
    })),
    persist: jest.fn((entry: unknown) => {
      persisted.push(entry)
    }),
    flush: jest.fn(),
  }
  return { em, persisted }
}

describe('backfillCustomFieldDictionaryEntries', () => {
  it('adds missing dictionary entries from custom field values when apply is true', async () => {
    const dictionary = makeDictionary()
    const { em, persisted } = createEm({
      defs: [makeDef({})],
      dictionaries: [dictionary],
      values: [
        makeValue({ valueText: ' Benefits ', recordId: 'record-1' }),
        makeValue({ valueText: 'benefits', recordId: 'record-2' }),
        makeValue({ valueText: '   ', recordId: 'record-3' }),
      ],
      entries: [],
    })

    const result = await backfillCustomFieldDictionaryEntries(em as unknown as EntityManager, {
      tenantId: 'tenant-1',
      organizationId: 'org-1',
      apply: true,
    })

    expect(result).toMatchObject({
      dryRun: false,
      fieldsChecked: 1,
      uniqueValuesFound: 1,
      existingEntries: 0,
      entriesToCreate: 1,
      createdEntries: 1,
    })
    expect(persisted).toHaveLength(1)
    expect(persisted[0]).toMatchObject({
      dictionary,
      tenantId: 'tenant-1',
      organizationId: 'org-1',
      value: 'Benefits',
      normalizedValue: 'benefits',
      label: 'Benefits',
      color: null,
      icon: null,
    })
    expect(em.flush).toHaveBeenCalledTimes(1)
  })

  it('does not write in dry-run mode', async () => {
    const { em, persisted } = createEm({
      defs: [makeDef({})],
      dictionaries: [makeDictionary()],
      values: [makeValue({ valueText: 'Support' })],
      entries: [],
    })

    const result = await backfillCustomFieldDictionaryEntries(em as unknown as EntityManager, {
      tenantId: 'tenant-1',
      organizationId: 'org-1',
    })

    expect(result).toMatchObject({
      dryRun: true,
      entriesToCreate: 1,
      createdEntries: 0,
    })
    expect(persisted).toHaveLength(0)
    expect(em.flush).not.toHaveBeenCalled()
  })

  it('skips existing entries without updating label or appearance', async () => {
    const dictionary = makeDictionary()
    const existing = makeEntry({ dictionary, label: 'Keep me', color: '#112233', icon: 'star' })
    const { em, persisted } = createEm({
      defs: [makeDef({})],
      dictionaries: [dictionary],
      values: [makeValue({ valueText: ' benefits ' })],
      entries: [existing],
    })

    const result = await backfillCustomFieldDictionaryEntries(em as unknown as EntityManager, {
      tenantId: 'tenant-1',
      organizationId: 'org-1',
      apply: true,
    })

    expect(result).toMatchObject({
      existingEntries: 1,
      entriesToCreate: 0,
      createdEntries: 0,
    })
    expect(existing).toMatchObject({ label: 'Keep me', color: '#112233', icon: 'star' })
    expect(persisted).toHaveLength(0)
    expect(em.flush).toHaveBeenCalledTimes(1)
  })

  it('ignores custom fields without dictionaryId', async () => {
    const { em } = createEm({
      defs: [makeDef({ configJson: { options: ['Benefits'] } })],
      dictionaries: [makeDictionary()],
      values: [makeValue({ valueText: 'Benefits' })],
      entries: [],
    })

    const result = await backfillCustomFieldDictionaryEntries(em as unknown as EntityManager, {
      tenantId: 'tenant-1',
      organizationId: 'org-1',
      apply: true,
    })

    expect(result.fieldsChecked).toBe(0)
    expect(result.entriesToCreate).toBe(0)
    expect(em.find).toHaveBeenCalledTimes(1)
    expect(em.flush).not.toHaveBeenCalled()
  })

  it('uses entity and field filters when provided', async () => {
    const selectedDef = makeDef({ entityId: 'customers:customer_person_profile', key: 'industry_external' })
    const otherDef = makeDef({
      entityId: 'customers:customer_person_profile',
      key: 'ignored_field',
      configJson: { dictionaryId: 'dict-2' },
    })
    const { em } = createEm({
      defs: [selectedDef, otherDef],
      dictionaries: [makeDictionary()],
      values: [makeValue({ fieldKey: 'industry_external', valueText: 'Benefits' })],
      entries: [],
    })

    const result = await backfillCustomFieldDictionaryEntries(em as unknown as EntityManager, {
      tenantId: 'tenant-1',
      organizationId: 'org-1',
      entityId: 'customers:customer_person_profile',
      fieldKey: 'industry_external',
    })

    expect(result.fields).toHaveLength(1)
    expect(result.fields[0]).toMatchObject({
      entityId: 'customers:customer_person_profile',
      fieldKey: 'industry_external',
      entriesToCreate: 1,
    })
    expect(em.find).toHaveBeenCalledWith(CustomFieldDef, expect.objectContaining({
      entityId: 'customers:customer_person_profile',
    }))
  })
})
