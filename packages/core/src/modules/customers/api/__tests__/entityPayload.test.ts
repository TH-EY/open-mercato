/** @jest-environment node */

import { isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import {
  assertNoUnknownPayloadFields,
  foldFlatNextInteractionPayload,
  normalizeCustomerEntityPayload,
} from '../entityPayload'

const translate = (_key: string, fallback?: string, params?: Record<string, unknown>) => {
  const template = fallback ?? _key
  if (!params) return template
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => (
    params[key] === undefined ? match : String(params[key])
  ))
}

function captureCrudError(run: () => unknown): { status: number; body: Record<string, unknown> } {
  try {
    run()
  } catch (err) {
    if (isCrudHttpError(err)) return { status: err.status, body: err.body }
    throw err
  }
  throw new Error('[internal] expected a CrudHttpError to be thrown')
}

// The write schemas expect `nextInteraction: { at, name }`, while every read surface exposes the
// projection flat (`nextInteractionAt` on the detail GET, `next_interaction_at` on the list GET).
// Before this fold a read-modify-write round trip lost the reminder date silently.
describe('foldFlatNextInteractionPayload', () => {
  it('leaves a payload without any flat next-interaction key untouched', () => {
    const payload = { id: 'p1', primaryPhone: '+48 500 100 200' }
    expect(foldFlatNextInteractionPayload(payload, translate)).toBe(payload)
  })

  it('folds the camelCase detail-GET shape into the nested write shape', () => {
    const result = foldFlatNextInteractionPayload(
      {
        id: 'p1',
        primaryPhone: '+48 500 100 200',
        nextInteractionAt: '2026-09-01T09:00:00.000Z',
        nextInteractionName: 'Follow-up call',
        nextInteractionRefId: 'interaction-1',
        nextInteractionIcon: 'phone',
        nextInteractionColor: '#112233',
      },
      translate,
    )

    expect(result).toEqual({
      id: 'p1',
      primaryPhone: '+48 500 100 200',
      nextInteraction: {
        at: '2026-09-01T09:00:00.000Z',
        name: 'Follow-up call',
        refId: 'interaction-1',
        icon: 'phone',
        color: '#112233',
      },
    })
  })

  it('folds the snake_case list-GET shape into the nested write shape', () => {
    const result = foldFlatNextInteractionPayload(
      {
        id: 'p1',
        next_interaction_at: '2026-09-01T09:00:00.000Z',
        next_interaction_name: 'Follow-up call',
      },
      translate,
    )

    expect(result).toEqual({
      id: 'p1',
      nextInteraction: { at: '2026-09-01T09:00:00.000Z', name: 'Follow-up call' },
    })
  })

  it('treats a null date as an explicit clear', () => {
    const result = foldFlatNextInteractionPayload(
      { id: 'p1', nextInteractionAt: null, nextInteractionName: null },
      translate,
    )
    expect(result).toEqual({ id: 'p1', nextInteraction: null })
  })

  it('treats a blank date string as an explicit clear', () => {
    const result = foldFlatNextInteractionPayload({ id: 'p1', nextInteractionAt: '  ' }, translate)
    expect(result).toEqual({ id: 'p1', nextInteraction: null })
  })

  it('rejects mixing the nested and the flat shape', () => {
    const { status, body } = captureCrudError(() => foldFlatNextInteractionPayload(
      {
        nextInteraction: { at: '2026-09-01T09:00:00.000Z', name: 'A' },
        nextInteractionAt: '2026-09-02T09:00:00.000Z',
      },
      translate,
    ))
    expect(status).toBe(400)
    expect(body.code).toBe('NEXT_INTERACTION_CONFLICTING_SHAPES')
  })

  it('rejects the same field sent in two spellings', () => {
    const { status, body } = captureCrudError(() => foldFlatNextInteractionPayload(
      { nextInteractionAt: '2026-09-01T09:00:00.000Z', next_interaction_at: '2026-09-02T09:00:00.000Z' },
      translate,
    ))
    expect(status).toBe(400)
    expect(body.code).toBe('NEXT_INTERACTION_DUPLICATE_FIELD')
  })

  it('rejects flat fields without a date instead of writing a partial projection', () => {
    const { status, body } = captureCrudError(() => foldFlatNextInteractionPayload(
      { nextInteractionName: 'Follow-up call' },
      translate,
    ))
    expect(status).toBe(400)
    expect(body.code).toBe('NEXT_INTERACTION_AT_REQUIRED')
  })

  it('rejects a date without a name instead of failing the strict nested schema opaquely', () => {
    const { status, body } = captureCrudError(() => foldFlatNextInteractionPayload(
      { nextInteractionAt: '2026-09-01T09:00:00.000Z' },
      translate,
    ))
    expect(status).toBe(400)
    expect(body.code).toBe('NEXT_INTERACTION_NAME_REQUIRED')
  })
})

// Zod object schemas strip unknown keys by default, so before this guard a misspelled field was
// dropped in silence and the route still answered 200 — the caller could not notice the no-op.
describe('assertNoUnknownPayloadFields', () => {
  const allowed = ['displayName', 'primaryPhone', 'nextInteraction', 'tenantId', 'organizationId']

  it('accepts a payload built only from declared keys', () => {
    expect(() => assertNoUnknownPayloadFields(
      { displayName: 'Ada', primaryPhone: '+48 500 100 200', tenantId: 't1' },
      allowed,
      translate,
    )).not.toThrow()
  })

  it('accepts round-trip-only keys a client echoes back from a read', () => {
    expect(() => assertNoUnknownPayloadFields(
      { id: 'p1', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' },
      allowed,
      translate,
    )).not.toThrow()
  })

  it('accepts underscore-namespaced response-enricher output echoed back from a read', () => {
    expect(() => assertNoUnknownPayloadFields(
      { displayName: 'Ada', _example: { todoCount: 3 }, _meta: { enrichers: ['example'] } },
      allowed,
      translate,
    )).not.toThrow()
  })

  it('rejects an unknown field and names it in the response body', () => {
    const { status, body } = captureCrudError(() => assertNoUnknownPayloadFields(
      { displayName: 'Ada', nextInteractionn: '2026-09-01T09:00:00.000Z' },
      allowed,
      translate,
    ))
    expect(status).toBe(400)
    expect(body.code).toBe('UNKNOWN_PAYLOAD_FIELDS')
    expect(body.fields).toEqual(['nextInteractionn'])
    expect(body.error).toContain('nextInteractionn')
  })

  it('suggests the camelCase spelling when a snake_case read key is sent', () => {
    const { body } = captureCrudError(() => assertNoUnknownPayloadFields(
      { display_name: 'Ada' },
      allowed,
      translate,
    ))
    expect(body.fields).toEqual(['display_name'])
    expect(body.error).toContain('display_name -> displayName')
  })
})

describe('normalizeCustomerEntityPayload', () => {
  const allowed = ['displayName', 'primaryPhone', 'nextInteraction', 'tenantId', 'organizationId']

  it('folds the flat shape before the unknown-field guard runs', () => {
    const result = normalizeCustomerEntityPayload(
      {
        primaryPhone: '+48 500 100 200',
        nextInteractionAt: '2026-09-01T09:00:00.000Z',
        nextInteractionName: 'Follow-up call',
      },
      allowed,
      translate,
    )
    expect(result).toEqual({
      primaryPhone: '+48 500 100 200',
      nextInteraction: { at: '2026-09-01T09:00:00.000Z', name: 'Follow-up call' },
    })
  })
})
