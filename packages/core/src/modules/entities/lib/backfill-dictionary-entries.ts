import type { EntityManager } from '@mikro-orm/postgresql'
import { Dictionary, DictionaryEntry } from '@open-mercato/core/modules/dictionaries/data/entities'
import { normalizeDictionaryValue } from '@open-mercato/core/modules/dictionaries/lib/utils'
import { CustomFieldDef, CustomFieldValue } from '../data/entities'

export type BackfillDictionaryEntriesOptions = {
  tenantId: string
  organizationId: string
  entityId?: string
  fieldKey?: string
  apply?: boolean
}

export type BackfillDictionaryFieldReport = {
  entityId: string
  fieldKey: string
  dictionaryId: string
  dictionaryKey: string | null
  uniqueValuesFound: number
  existingEntries: number
  entriesToCreate: number
  createdEntries: number
  values: string[]
  missingDictionary: boolean
}

export type BackfillDictionaryEntriesResult = {
  dryRun: boolean
  fieldsChecked: number
  uniqueValuesFound: number
  existingEntries: number
  entriesToCreate: number
  createdEntries: number
  missingDictionaryFields: number
  fields: BackfillDictionaryFieldReport[]
}

type DictionaryBackedField = {
  entityId: string
  fieldKey: string
  dictionaryId: string
  updatedAt: Date
  score: number
}

function readDictionaryId(configJson: unknown): string | null {
  if (!configJson || typeof configJson !== 'object') return null
  const dictionaryId = (configJson as { dictionaryId?: unknown }).dictionaryId
  if (typeof dictionaryId !== 'string') return null
  const trimmed = dictionaryId.trim()
  return trimmed.length > 0 ? trimmed : null
}

function definitionScopeScore(def: CustomFieldDef, options: BackfillDictionaryEntriesOptions): number {
  const tenantScore = def.tenantId === options.tenantId ? 2 : 0
  const organizationScore = def.organizationId === options.organizationId ? 1 : 0
  return tenantScore + organizationScore
}

function selectDictionaryBackedFields(
  defs: CustomFieldDef[],
  options: BackfillDictionaryEntriesOptions,
): DictionaryBackedField[] {
  const selected = new Map<string, DictionaryBackedField>()

  for (const def of defs) {
    const dictionaryId = readDictionaryId(def.configJson)
    if (!dictionaryId) continue
    if (options.fieldKey && def.key !== options.fieldKey) continue

    const key = `${def.entityId}\u0000${def.key}`
    const candidate = {
      entityId: def.entityId,
      fieldKey: def.key,
      dictionaryId,
      updatedAt: def.updatedAt instanceof Date ? def.updatedAt : new Date(def.updatedAt),
      score: definitionScopeScore(def, options),
    }
    const existing = selected.get(key)
    if (!existing || candidate.score > existing.score || (
      candidate.score === existing.score && candidate.updatedAt.getTime() >= existing.updatedAt.getTime()
    )) {
      selected.set(key, candidate)
    }
  }

  return Array.from(selected.values())
}

function extractStoredValue(row: CustomFieldValue): string | null {
  const value =
    row.valueText ??
    row.valueMultiline ??
    row.valueInt ??
    row.valueFloat ??
    row.valueBool ??
    null
  if (value === null || value === undefined) return null
  const trimmed = String(value).trim()
  return trimmed.length > 0 ? trimmed : null
}

function getFieldPairKey(entityId: string, fieldKey: string): string {
  return `${entityId}\u0000${fieldKey}`
}

export async function backfillCustomFieldDictionaryEntries(
  em: EntityManager,
  options: BackfillDictionaryEntriesOptions,
): Promise<BackfillDictionaryEntriesResult> {
  const dryRun = options.apply !== true
  const defWhere: Record<string, unknown> = {
    isActive: true,
    deletedAt: null,
    tenantId: { $in: [options.tenantId, null] },
    organizationId: { $in: [options.organizationId, null] },
  }
  if (options.entityId) defWhere.entityId = options.entityId

  const defs = await em.find(CustomFieldDef, defWhere)
  const fields = selectDictionaryBackedFields(defs, options)

  const emptyResult: BackfillDictionaryEntriesResult = {
    dryRun,
    fieldsChecked: 0,
    uniqueValuesFound: 0,
    existingEntries: 0,
    entriesToCreate: 0,
    createdEntries: 0,
    missingDictionaryFields: 0,
    fields: [],
  }

  if (fields.length === 0) return emptyResult

  const dictionaryIds = Array.from(new Set(fields.map((field) => field.dictionaryId)))
  const dictionaries = await em.find(Dictionary, {
    id: { $in: dictionaryIds },
    tenantId: options.tenantId,
    organizationId: options.organizationId,
    deletedAt: null,
  })
  const dictionariesById = new Map(dictionaries.map((dictionary) => [dictionary.id, dictionary]))

  const entityIds = Array.from(new Set(fields.map((field) => field.entityId)))
  const fieldKeys = Array.from(new Set(fields.map((field) => field.fieldKey)))
  const rawValues = await em.find(CustomFieldValue, {
    entityId: { $in: entityIds },
    fieldKey: { $in: fieldKeys },
    tenantId: options.tenantId,
    organizationId: options.organizationId,
    deletedAt: null,
  })

  const valuesByField = new Map<string, Map<string, string>>()
  const fieldPairs = new Set(fields.map((field) => getFieldPairKey(field.entityId, field.fieldKey)))
  for (const row of rawValues) {
    const pairKey = getFieldPairKey(row.entityId, row.fieldKey)
    if (!fieldPairs.has(pairKey)) continue
    const value = extractStoredValue(row)
    if (!value) continue
    const normalized = normalizeDictionaryValue(value)
    if (!valuesByField.has(pairKey)) valuesByField.set(pairKey, new Map())
    const fieldValues = valuesByField.get(pairKey)!
    if (!fieldValues.has(normalized)) fieldValues.set(normalized, value)
  }

  const existingByDictionary = new Map<string, Set<string>>()
  for (const dictionary of dictionaries) {
    const entries = await em.find(DictionaryEntry, {
      dictionary,
      tenantId: options.tenantId,
      organizationId: options.organizationId,
    })
    existingByDictionary.set(
      dictionary.id,
      new Set(entries.map((entry) => entry.normalizedValue || normalizeDictionaryValue(entry.value))),
    )
  }

  const reports: BackfillDictionaryFieldReport[] = []
  for (const field of fields) {
    const dictionary = dictionariesById.get(field.dictionaryId) ?? null
    const values = valuesByField.get(getFieldPairKey(field.entityId, field.fieldKey)) ?? new Map<string, string>()
    const existing = dictionary ? existingByDictionary.get(dictionary.id) ?? new Set<string>() : new Set<string>()
    const missingValues = dictionary
      ? Array.from(values.entries())
          .filter(([normalized]) => !existing.has(normalized))
          .map(([, value]) => value)
      : []

    if (dictionary && !dryRun) {
      for (const value of missingValues) {
        const entry = em.create(DictionaryEntry, {
          dictionary,
          tenantId: options.tenantId,
          organizationId: options.organizationId,
          value,
          normalizedValue: normalizeDictionaryValue(value),
          label: value,
          color: null,
          icon: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        em.persist(entry)
        existing.add(normalizeDictionaryValue(value))
      }
    }

    reports.push({
      entityId: field.entityId,
      fieldKey: field.fieldKey,
      dictionaryId: field.dictionaryId,
      dictionaryKey: dictionary?.key ?? null,
      uniqueValuesFound: values.size,
      existingEntries: values.size - missingValues.length,
      entriesToCreate: missingValues.length,
      createdEntries: dictionary && !dryRun ? missingValues.length : 0,
      values: missingValues,
      missingDictionary: !dictionary,
    })
  }

  if (!dryRun) {
    await em.flush()
  }

  return reports.reduce<BackfillDictionaryEntriesResult>((acc, report) => ({
    dryRun,
    fieldsChecked: acc.fieldsChecked + 1,
    uniqueValuesFound: acc.uniqueValuesFound + report.uniqueValuesFound,
    existingEntries: acc.existingEntries + report.existingEntries,
    entriesToCreate: acc.entriesToCreate + report.entriesToCreate,
    createdEntries: acc.createdEntries + report.createdEntries,
    missingDictionaryFields: acc.missingDictionaryFields + (report.missingDictionary ? 1 : 0),
    fields: [...acc.fields, report],
  }), { ...emptyResult, fields: [] })
}
