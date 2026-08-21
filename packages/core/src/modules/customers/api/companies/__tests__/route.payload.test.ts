/** @jest-environment node */

// The companies write surface has the same read/write shape mismatch as people: every GET exposes
// the next-interaction projection flat, the PUT declares it nested, and zod silently stripped the
// flat spelling. This mirrors the people coverage so a regression in the companies wiring (a wrong
// schema key list, a missing normalizer call) cannot pass unnoticed.

let capturedCrudOptions: Record<string, any> | null = null

jest.mock('@open-mercato/shared/lib/crud/factory', () => ({
  makeCrudRoute: jest.fn((opts: Record<string, any>) => {
    capturedCrudOptions = opts
    return {
      GET: jest.fn(),
      POST: jest.fn(),
      PUT: jest.fn(),
      DELETE: jest.fn(),
    }
  }),
}))

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findWithDecryption: jest.fn(async () => []),
}))

jest.mock('@open-mercato/shared/lib/i18n/server', () => ({
  resolveTranslations: jest.fn(async () => ({
    translate: (key: string, fallback?: string, params?: Record<string, unknown>) => {
      const template = fallback ?? key
      if (!params) return template
      return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => (
        params[name] === undefined ? match : String(params[name])
      ))
    },
  })),
}))

describe('customers companies route payload guards', () => {
  const ctx = {
    auth: { tenantId: '11111111-1111-4111-8111-111111111111', orgId: '22222222-2222-4222-8222-222222222222' },
    selectedOrganizationId: '22222222-2222-4222-8222-222222222222',
  }
  const companyId = '44444444-4444-4444-8444-444444444444'

  const mapUpdate = (raw: Record<string, unknown>) =>
    capturedCrudOptions?.actions?.update?.mapInput?.({ raw, parsed: raw, ctx })

  const mapCreate = (raw: Record<string, unknown>) =>
    capturedCrudOptions?.actions?.create?.mapInput?.({ raw, parsed: raw, ctx })

  beforeAll(async () => {
    await import('../route')
  })

  it('persists the flat next-interaction read shape on update', async () => {
    const input = await mapUpdate({
      id: companyId,
      nextInteractionAt: '2026-09-01T09:00:00.000Z',
      nextInteractionName: 'Renewal review',
    })
    expect(input.nextInteraction).toEqual({
      at: new Date('2026-09-01T09:00:00.000Z'),
      name: 'Renewal review',
    })
  })

  it('clears the reminder when the flat date is null', async () => {
    const input = await mapUpdate({ id: companyId, nextInteractionAt: null })
    expect(input.nextInteraction).toBeNull()
  })

  it('rejects an unrecognised field on update instead of reporting a hollow success', async () => {
    await expect(mapUpdate({ id: companyId, nextInteractionDate: '2026-09-01T09:00:00.000Z' }))
      .rejects.toMatchObject({
        status: 400,
        body: expect.objectContaining({ code: 'UNKNOWN_PAYLOAD_FIELDS', fields: ['nextInteractionDate'] }),
      })
  })

  it('rejects an unrecognised field on create as well', async () => {
    await expect(mapCreate({ displayName: 'Acme', legal_name: 'Acme Sp. z o.o.' }))
      .rejects.toMatchObject({
        status: 400,
        body: expect.objectContaining({ code: 'UNKNOWN_PAYLOAD_FIELDS', fields: ['legal_name'] }),
      })
  })

  it('leaves a payload that only touches declared fields working unchanged', async () => {
    const input = await mapUpdate({ id: companyId, displayName: 'Acme', industry: 'software' })
    expect(input).toMatchObject({ id: companyId, displayName: 'Acme', industry: 'software' })
  })
})
