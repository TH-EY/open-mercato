import type { DataEngine } from '../data/engine'
import { CrudHttpError } from '../crud/errors'

type CustomFieldValueInput = Parameters<DataEngine['setCustomFields']>[0]['values']

const CUSTOM_FIELD_PREFIXES = ['cf_', 'cf:'] as const

export function canonicalizeCustomFieldInputKey(rawKey: string): string {
  const trimmed = rawKey.trim()
  const prefix = CUSTOM_FIELD_PREFIXES.find((candidate) => trimmed.startsWith(candidate))
  const canonical = prefix ? trimmed.slice(prefix.length) : trimmed
  if (!canonical || CUSTOM_FIELD_PREFIXES.some((candidate) => canonical.startsWith(candidate))) {
    throw new CrudHttpError(400, {
      error: 'Validation failed',
      fields: { [`cf_${trimmed || 'unknown'}`]: 'Ambiguous custom field key' },
    })
  }
  return canonical
}

export function canonicalizeCustomFieldValueKeys<TValue>(values: Record<string, TValue>): Record<string, TValue> {
  const canonical: Record<string, TValue> = {}
  const sourceByKey = new Map<string, string>()
  for (const [rawKey, value] of Object.entries(values)) {
    const key = canonicalizeCustomFieldInputKey(rawKey)
    const previousSource = sourceByKey.get(key)
    if (previousSource && previousSource !== rawKey) {
      throw new CrudHttpError(400, {
        error: 'Validation failed',
        fields: { [`cf_${key}`]: 'Ambiguous custom field key' },
      })
    }
    sourceByKey.set(key, rawKey)
    canonical[key] = value
  }
  return canonical
}

export function normalizeCustomFieldValues(values: Record<string, unknown>): CustomFieldValueInput {
  const result: CustomFieldValueInput = {}
  for (const [key, value] of Object.entries(canonicalizeCustomFieldValueKeys(values))) {
    if (Array.isArray(value)) {
      result[key] = value.map((entry) => normalizePrimitive(entry)) as CustomFieldValueInput[string]
    } else {
      result[key] = normalizePrimitive(value)
    }
  }
  return result
}

function normalizePrimitive(value: unknown): CustomFieldValueInput[string] {
  if (
    value === null ||
    value === undefined ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value as CustomFieldValueInput[string]
  }
  return String(value) as CustomFieldValueInput[string]
}

export function normalizeCustomFieldResponse(
  values: Record<string, unknown> | null | undefined,
): Record<string, unknown> | undefined {
  if (!values) return undefined
  const entries: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue
    if (key.startsWith('cf_') || key.startsWith('cf:')) {
      const normalized = key.slice(3)
      if (normalized) entries[normalized] = value
      continue
    }
    entries[key] = value
  }
  return Object.keys(entries).length ? entries : undefined
}
