import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import type { TranslateWithFallbackFn } from '@open-mercato/shared/lib/i18n/translate'

// Keys a client may echo back from a read response without meaning to write them.
// `profile` is consumed earlier by normalizeProfilePayload / normalizeCompanyProfilePayload.
//
// `customFields` / `customValues` are consumed earlier by splitCustomFieldPayload and reach this
// guard only when their value has the wrong type (a string instead of an object or array), which
// makes that helper fall through. They are listed here so the error never claims a supported field
// is "unsupported" — a malformed custom-field value keeps splitCustomFieldPayload's existing
// module-wide behaviour, which is out of this guard's scope.
const IGNORED_ROUND_TRIP_KEYS = new Set([
  'id',
  'createdAt',
  'updatedAt',
  'profile',
  'customFields',
  'customValues',
])

// Response enrichers namespace their output with a leading underscore (`_example.todoCount`,
// `_meta`) and it is read-only by contract — exports strip it too. A client that PUTs back a
// record it just read carries those keys through no fault of its own, so they are ignored
// rather than reported as unknown.
const isEnrichedReadOnlyKey = (key: string): boolean => key.startsWith('_')

type NextInteractionField = 'at' | 'name' | 'refId' | 'icon' | 'color'

// The read surfaces expose the next-interaction projection flat: the detail GET in camelCase
// (`nextInteractionAt`), the list GET in snake_case (`next_interaction_at`). The write surface
// expects the nested `nextInteraction` object. Accept both flat spellings on write so a
// read-modify-write round trip persists the reminder instead of being stripped by zod.
const FLAT_NEXT_INTERACTION_KEYS: Record<NextInteractionField, readonly string[]> = {
  at: ['nextInteractionAt', 'next_interaction_at'],
  name: ['nextInteractionName', 'next_interaction_name'],
  refId: ['nextInteractionRefId', 'next_interaction_ref_id'],
  icon: ['nextInteractionIcon', 'next_interaction_icon'],
  color: ['nextInteractionColor', 'next_interaction_color'],
}

const NEXT_INTERACTION_FIELD_ORDER: readonly NextInteractionField[] = ['at', 'name', 'refId', 'icon', 'color']

function snakeToCamel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase())
}

function isBlankString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length === 0
}

function readSuppliedSpellings(
  payload: Record<string, unknown>,
  spellings: readonly string[],
): string[] {
  return spellings.filter((key) => key in payload)
}

/**
 * Folds the flat `nextInteraction*` read shape into the nested `nextInteraction` object the
 * customers write schemas declare.
 *
 * - `nextInteractionAt: null` (or a blank string) clears the whole projection.
 * - Supplying both the nested and a flat spelling is a 400 — the caller's intent is ambiguous.
 * - Supplying flat fields without a resolvable `at`/`name` pair is a 400 rather than a partial write.
 */
export function foldFlatNextInteractionPayload(
  payload: Record<string, unknown>,
  translate: TranslateWithFallbackFn,
): Record<string, unknown> {
  const supplied = new Map<NextInteractionField, { key: string; value: unknown }>()

  for (const field of NEXT_INTERACTION_FIELD_ORDER) {
    const spellings = readSuppliedSpellings(payload, FLAT_NEXT_INTERACTION_KEYS[field])
    if (spellings.length === 0) continue
    if (spellings.length > 1) {
      throw new CrudHttpError(400, {
        error: translate(
          'customers.errors.next_interaction_duplicate_field',
          'Next interaction field provided in more than one spelling: {{fields}}',
          { fields: spellings.join(', ') },
        ),
        code: 'NEXT_INTERACTION_DUPLICATE_FIELD',
        fields: spellings,
      })
    }
    supplied.set(field, { key: spellings[0], value: payload[spellings[0]] })
  }

  if (supplied.size === 0) return payload

  if ('nextInteraction' in payload) {
    throw new CrudHttpError(400, {
      error: translate(
        'customers.errors.next_interaction_conflicting_shapes',
        'Send either nextInteraction or the flat nextInteraction* fields, not both.',
      ),
      code: 'NEXT_INTERACTION_CONFLICTING_SHAPES',
    })
  }

  const result = { ...payload }
  for (const entry of supplied.values()) {
    delete result[entry.key]
  }

  const at = supplied.get('at')
  if (!at) {
    throw new CrudHttpError(400, {
      error: translate(
        'customers.errors.next_interaction_at_required',
        'nextInteractionAt is required when setting the next interaction.',
      ),
      code: 'NEXT_INTERACTION_AT_REQUIRED',
    })
  }

  if (at.value === null || isBlankString(at.value)) {
    result.nextInteraction = null
    return result
  }

  const name = supplied.get('name')
  if (!name || typeof name.value !== 'string' || name.value.trim().length === 0) {
    throw new CrudHttpError(400, {
      error: translate(
        'customers.errors.next_interaction_name_required',
        'nextInteractionName is required when setting a next interaction date.',
      ),
      code: 'NEXT_INTERACTION_NAME_REQUIRED',
    })
  }

  const nested: Record<string, unknown> = { at: at.value, name: name.value }
  for (const field of ['refId', 'icon', 'color'] as const) {
    const entry = supplied.get(field)
    if (entry) nested[field] = entry.value
  }
  result.nextInteraction = nested
  return result
}

/**
 * Fails a write whose payload carries a field no write schema declares.
 *
 * Zod object schemas strip unknown keys by default, so before this guard a misspelled or
 * read-shape-only field was dropped in silence and the route still answered `200 {ok:true}` —
 * the caller had no way to notice the write never happened.
 */
export function assertNoUnknownPayloadFields(
  payload: Record<string, unknown>,
  allowedKeys: Iterable<string>,
  translate: TranslateWithFallbackFn,
): void {
  const allowed = new Set(allowedKeys)
  const unknown: string[] = []
  const suggestions: string[] = []

  for (const key of Object.keys(payload)) {
    if (allowed.has(key) || IGNORED_ROUND_TRIP_KEYS.has(key) || isEnrichedReadOnlyKey(key)) continue
    unknown.push(key)
    const camel = snakeToCamel(key)
    if (camel !== key && allowed.has(camel)) suggestions.push(`${key} -> ${camel}`)
  }

  if (unknown.length === 0) return

  const body: Record<string, unknown> = {
    error: suggestions.length
      ? translate(
          'customers.errors.unknown_payload_fields_with_hint',
          'Unsupported field(s): {{fields}}. Did you mean: {{suggestions}}?',
          { fields: unknown.join(', '), suggestions: suggestions.join(', ') },
        )
      : translate(
          'customers.errors.unknown_payload_fields',
          'Unsupported field(s): {{fields}}',
          { fields: unknown.join(', ') },
        ),
    code: 'UNKNOWN_PAYLOAD_FIELDS',
    fields: unknown,
  }
  throw new CrudHttpError(400, body)
}

/**
 * Runs both guards in the only correct order: fold the flat next-interaction shape into the
 * nested one FIRST, so the flat keys are consumed rather than reported as unknown.
 */
export function normalizeCustomerEntityPayload(
  payload: Record<string, unknown>,
  allowedKeys: Iterable<string>,
  translate: TranslateWithFallbackFn,
): Record<string, unknown> {
  const folded = foldFlatNextInteractionPayload(payload, translate)
  assertNoUnknownPayloadFields(folded, allowedKeys, translate)
  return folded
}
