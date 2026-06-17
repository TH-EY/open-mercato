import {
  buildDealCustomFields,
  buildLeadDescription,
  ensureEpcLeadCaptureMetadata,
  epcLeadCaptureSchema,
  normalizeLeadCapturePhone,
  resolveEpcLeadCaptureCorsConfig,
  resolveEpcLeadCaptureScope,
  splitFullName,
} from '../leadCapture'
import {
  EPC_PROJECT_TYPE_DICTIONARY_ID,
  EPC_PROJECT_TYPE_FIELD_KEY,
  EPC_SERVICE_NEEDED_DICTIONARY_ID,
  EPC_SERVICE_NEEDED_FIELD_KEY,
} from '../leadCaptureConstants'

const validPayload = {
  fullName: 'Alex Green',
  email: 'alex@example.com',
  phone: '+44 1245 010101',
  addressLine1: '18 Beaulieu View',
  city: 'Chelmsford',
  postalCode: 'CM1 6UX',
  serviceNeeded: ['heat_pumps', 'solar_panels'],
  projectType: ['retrofit', 'renovation'],
}

describe('EPC lead capture', () => {
  it('validates required contact, address and checkbox arrays', () => {
    const parsed = epcLeadCaptureSchema.safeParse(validPayload)

    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.country).toBe('GB')
    expect(parsed.data.serviceNeeded).toEqual(['heat_pumps', 'solar_panels'])
    expect(parsed.data.projectType).toEqual(['retrofit', 'renovation'])
  })

  it('rejects empty checkbox arrays', () => {
    const parsed = epcLeadCaptureSchema.safeParse({
      ...validPayload,
      serviceNeeded: [],
      projectType: [],
    })

    expect(parsed.success).toBe(false)
  })

  it('maps checkbox arrays to the existing deal custom field keys', () => {
    expect(buildDealCustomFields({
      serviceNeeded: ['heat_pumps', 'heat_pumps', 'solar_panels'],
      projectType: ['retrofit', 'commercial'],
    })).toEqual({
      [EPC_SERVICE_NEEDED_FIELD_KEY]: ['heat_pumps', 'solar_panels'],
      [EPC_PROJECT_TYPE_FIELD_KEY]: ['retrofit', 'commercial'],
    })
  })

  it('builds readable deal descriptions with selected labels', () => {
    const parsed = epcLeadCaptureSchema.parse({
      ...validPayload,
      message: 'Please call after 5pm.',
    })

    expect(buildLeadDescription(parsed)).toContain('Message: Please call after 5pm.')
    expect(buildLeadDescription(parsed)).toContain('Phone: +44 1245 010101')
    expect(buildLeadDescription(parsed)).toContain('Service needed: Heat Pumps, Solar Panels')
    expect(buildLeadDescription(parsed)).toContain('Project type: Retrofit, Renovation')
  })

  it('normalizes GB local phone numbers before creating CRM people', () => {
    expect(normalizeLeadCapturePhone('01245 000 222', 'GB')).toBe('+441245000222')
    expect(normalizeLeadCapturePhone('+44 1245 000 222', 'GB')).toBe('+44 1245 000 222')
    expect(normalizeLeadCapturePhone('123', 'GB')).toBeUndefined()
    expect(normalizeLeadCapturePhone('01245 000 222', 'US')).toBeUndefined()
  })

  it('splits single-token names with a stable fallback last name', () => {
    expect(splitFullName('Alex')).toEqual({ firstName: 'Alex', lastName: 'Lead' })
    expect(splitFullName('Alex Morgan Green')).toEqual({ firstName: 'Alex Morgan', lastName: 'Green' })
  })

  it('resolves server-side scope only when required IDs are valid', () => {
    expect(resolveEpcLeadCaptureScope({
      EPC_LEAD_TENANT_ID: '11111111-1111-4111-8111-111111111111',
      EPC_LEAD_ORGANIZATION_ID: '22222222-2222-4222-8222-222222222222',
      EPC_LEAD_OWNER_USER_ID: '33333333-3333-4333-8333-333333333333',
      EPC_LEAD_PIPELINE_STAGE_ID: '44444444-4444-4444-8444-444444444444',
    } as NodeJS.ProcessEnv)).toEqual({
      tenantId: '11111111-1111-4111-8111-111111111111',
      organizationId: '22222222-2222-4222-8222-222222222222',
      ownerUserId: '33333333-3333-4333-8333-333333333333',
      pipelineStageId: '44444444-4444-4444-8444-444444444444',
    })

    expect(resolveEpcLeadCaptureScope({} as NodeJS.ProcessEnv)).toBeNull()
  })

  it('allows CORS only for same-origin or configured external form origins', () => {
    expect(resolveEpcLeadCaptureCorsConfig(
      'https://external-form.example',
      'https://preview-epc.om.they.dev/api/epc/lead-capture',
      {
        EPC_LEAD_CAPTURE_ALLOWED_ORIGINS: 'https://external-form.example',
      } as NodeJS.ProcessEnv,
    )).toEqual(expect.objectContaining({
      allowed: true,
      headers: expect.objectContaining({
        'Access-Control-Allow-Origin': 'https://external-form.example',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'content-type',
        Vary: 'Origin',
      }),
    }))

    expect(resolveEpcLeadCaptureCorsConfig(
      'https://preview-epc.om.they.dev',
      'https://preview-epc.om.they.dev/api/epc/lead-capture',
      {} as NodeJS.ProcessEnv,
    ).allowed).toBe(true)

    expect(resolveEpcLeadCaptureCorsConfig(
      'https://not-allowed.example',
      'https://preview-epc.om.they.dev/api/epc/lead-capture',
      {
        EPC_LEAD_CAPTURE_ALLOWED_ORIGINS: 'https://external-form.example',
      } as NodeJS.ProcessEnv,
    ).allowed).toBe(false)

    expect(resolveEpcLeadCaptureCorsConfig(
      null,
      'https://preview-epc.om.they.dev/api/epc/lead-capture',
      {} as NodeJS.ProcessEnv,
    ).allowed).toBe(true)
  })

  it('repairs dictionaries, entries and deal custom field definitions idempotently', async () => {
    const em = createMetadataEntityManagerMock()
    const scope = {
      tenantId: '11111111-1111-4111-8111-111111111111',
      organizationId: '22222222-2222-4222-8222-222222222222',
    }

    await ensureEpcLeadCaptureMetadata(em as never, scope)

    expect(em.createdDictionaries).toHaveLength(2)
    expect(em.createdDictionaries.map((entry) => entry.id)).toEqual([
      EPC_SERVICE_NEEDED_DICTIONARY_ID,
      EPC_PROJECT_TYPE_DICTIONARY_ID,
    ])
    expect(em.createdEntries).toHaveLength(13)
    expect(em.createdFieldDefs).toEqual([
      expect.objectContaining({
        entityId: 'customers:customer_deal',
        key: EPC_SERVICE_NEEDED_FIELD_KEY,
        kind: 'dictionary',
        configJson: expect.objectContaining({
          dictionaryId: EPC_SERVICE_NEEDED_DICTIONARY_ID,
          multi: true,
          dictionaryInlineCreate: true,
        }),
      }),
      expect.objectContaining({
        entityId: 'customers:customer_deal',
        key: EPC_PROJECT_TYPE_FIELD_KEY,
        kind: 'dictionary',
        configJson: expect.objectContaining({
          dictionaryId: EPC_PROJECT_TYPE_DICTIONARY_ID,
          multi: true,
          dictionaryInlineCreate: true,
        }),
      }),
    ])
    expect(em.flush).toHaveBeenCalledTimes(1)
  })
})

function createMetadataEntityManagerMock() {
  const state = {
    createdDictionaries: [] as Array<Record<string, unknown>>,
    createdEntries: [] as Array<Record<string, unknown>>,
    createdFieldDefs: [] as Array<Record<string, unknown>>,
    async findOne() {
      return null
    },
    create(_entity: unknown, payload: Record<string, unknown>) {
      if ('key' in payload && 'name' in payload && !('entityId' in payload)) {
        state.createdDictionaries.push(payload)
      } else if ('normalizedValue' in payload) {
        state.createdEntries.push(payload)
      } else if ('entityId' in payload) {
        state.createdFieldDefs.push(payload)
      }
      return payload
    },
    persist: jest.fn(),
    flush: jest.fn(async () => undefined),
  }
  return state
}
