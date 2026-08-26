import { MetadataStorage } from '@mikro-orm/core'
import { asValue, createContainer, InjectionMode } from 'awilix'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import { entities, FINOO_CUSTOMER_RETENTION_FIELDS } from '../ce'
import {
  FinooCustomerRetentionSettings,
  FinooCustomerRetentionState,
} from '../data/entities'
import {
  finooCustomerRetentionSettingsSchema,
  finooCustomerRetentionSettingsChangeSchema,
  finooCustomerRetentionStateSchema,
  finooCustomerRetentionStatusSchema,
} from '../data/validators'
import { register } from '../di'
import { metadata } from '../index'

function metadataFor(entity: Function) {
  const path = (entity as unknown as Record<symbol, string>)[MetadataStorage.PATH_SYMBOL]
  return MetadataStorage.getMetadata(entity.name, path)
}

describe('finoo_customer_retention foundation', () => {
  it('requires the narrow identity retention provider module', () => {
    expect(metadata.requires).toContain('finoo_identities')
  })

  it('declares the scoped settings singleton and retention state without ORM relations', () => {
    const settings = metadataFor(FinooCustomerRetentionSettings)
    const state = metadataFor(FinooCustomerRetentionState)

    expect(settings?.tableName).toBe('finoo_customer_retention_settings')
    expect(settings?.uniques.map((unique) => unique.name)).toContain(
      'finoo_customer_retention_settings_scope_unique',
    )
    expect(settings?.properties.updatedAt.onUpdate).toEqual(expect.any(Function))
    expect(state?.tableName).toBe('finoo_customer_retention_states')
    expect(state?.indexes.map((index) => index.name)).toEqual(expect.arrayContaining([
      'finoo_customer_retention_states_scope_customer_unique',
      'finoo_customer_retention_states_scope_expiry_idx',
      'finoo_customer_retention_states_scope_customer_keyset_idx',
      'finoo_customer_retention_states_scope_pending_erasure_idx',
    ]))
    expect(state?.properties.customerEntityId.fieldName).toBe('customer_entity_id')
    expect(state?.properties.identityErasedAt.fieldName).toBe('identity_erased_at')
    expect(Object.values(state?.properties ?? {}).every((property) => property.kind === 'scalar')).toBe(true)
  })

  it('validates the exact settings and state boundaries', () => {
    expect(finooCustomerRetentionStatusSchema.options).toEqual(['active', 'expired', 'excluded'])
    expect(finooCustomerRetentionSettingsSchema.safeParse({
      id: '11111111-1111-4111-8111-111111111111',
      tenantId: '22222222-2222-4222-8222-222222222222',
      organizationId: '33333333-3333-4333-8333-333333333333',
      inactivityWindowDays: 3650,
      previewTokenHash: 'a'.repeat(64),
      previewWindowDays: 1,
      previewTotalEligible: 10,
      previewNewlyExpired: 2,
      previewAlreadyExpired: 1,
      previewExpiresAt: null,
      reconciliationGeneration: 0,
      createdAt: '2026-08-24T10:00:00.000Z',
      updatedAt: '2026-08-24T10:00:00.000Z',
    }).success).toBe(true)
    expect(finooCustomerRetentionSettingsChangeSchema.safeParse({ inactivityWindowDays: null }).success).toBe(true)
    expect(finooCustomerRetentionSettingsChangeSchema.safeParse({ inactivityWindowDays: 1 }).success).toBe(true)
    expect(finooCustomerRetentionSettingsChangeSchema.safeParse({ inactivityWindowDays: 3650 }).success).toBe(true)
    expect(finooCustomerRetentionSettingsChangeSchema.safeParse({ inactivityWindowDays: 0 }).success).toBe(false)
    expect(finooCustomerRetentionSettingsChangeSchema.safeParse({ inactivityWindowDays: 3651 }).success).toBe(false)
    expect(finooCustomerRetentionSettingsChangeSchema.safeParse({ inactivityWindowDays: 1.5 }).success).toBe(false)
    expect(finooCustomerRetentionSettingsChangeSchema.safeParse({ inactivityWindowDays: '30' }).success).toBe(false)
    expect(finooCustomerRetentionStateSchema.safeParse({ retentionStatus: 'unknown' }).success).toBe(false)
  })

  it('exports read-only filterable person-profile custom fields', () => {
    expect(entities).toEqual([{
      id: 'customers:customer_person_profile',
      fields: FINOO_CUSTOMER_RETENTION_FIELDS,
    }])
    expect(FINOO_CUSTOMER_RETENTION_FIELDS).toEqual([
      expect.objectContaining({
        key: 'finoo_retention_status',
        kind: 'select',
        options: expect.arrayContaining([
          { value: 'excluded', label: 'Not applicable' },
        ]),
        filterable: true,
        indexed: true,
        listVisible: true,
        formEditable: false,
      }),
      expect.objectContaining({
        key: 'finoo_retention_expires_at',
        kind: 'datetime',
        filterable: true,
        indexed: true,
        listVisible: true,
        formEditable: false,
      }),
    ])
  })

  it('resolves all services with the application CLASSIC injection mode', () => {
    const em = { marker: 'em' }
    const queryEngine = { marker: 'queryEngine' }
    const container = createContainer({ injectionMode: InjectionMode.CLASSIC })
    container.register({ em: asValue(em), queryEngine: asValue(queryEngine) })
    register(container as AppContainer)

    expect(container.resolve('finooCustomerRetentionProjectionService')).toBeDefined()
    expect(container.resolve('finooCustomerRetentionPreviewService')).toBeDefined()
    expect(container.resolve('finooCustomerRetentionSettingsService')).toBeDefined()
  })
})
