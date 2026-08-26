import type { EntityManager } from '@mikro-orm/postgresql'
import type { CacheStrategy } from '@open-mercato/cache'
import { CustomFieldDef } from '@open-mercato/core/modules/entities/data/entities'
import { invalidateDefinitionsCache } from '@open-mercato/core/modules/entities/api/definitions.cache'
import { ensureCustomFieldDefinitions } from '@open-mercato/core/modules/entities/lib/field-definitions'
import type { CustomFieldDefinition } from '@open-mercato/shared/modules/entities'
import { FINOO_CUSTOMER_RETENTION_FIELDS } from '../ce'

const PERSON_PROFILE_ENTITY_ID = 'customers:customer_person_profile'

const retentionFields: CustomFieldDefinition[] = FINOO_CUSTOMER_RETENTION_FIELDS.map(
  (field, priority) => ({ ...field, priority }),
)

function normalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeValue(item))
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort((left, right) => left.localeCompare(right))
      .reduce<Record<string, unknown>>((result, key) => {
        result[key] = normalizeValue((value as Record<string, unknown>)[key])
        return result
      }, {})
  }
  return value
}

function expectedConfig(field: CustomFieldDefinition): Record<string, unknown> {
  const { key: _key, kind: _kind, ...config } = field
  return config
}

export type FinooRetentionCustomFieldDefinitionReport = {
  created: number
  updated: number
  unchanged: number
  verified: number
}

export async function ensureFinooCustomerRetentionCustomFieldDefinitions(input: {
  em: EntityManager
  cache?: CacheStrategy
  tenantId: string
}): Promise<FinooRetentionCustomFieldDefinitionReport> {
  const result = await ensureCustomFieldDefinitions(
    input.em,
    [{ entity: PERSON_PROFILE_ENTITY_ID, fields: retentionFields }],
    { tenantId: input.tenantId, organizationId: null },
  )
  if (result.created > 0 || result.updated > 0) {
    await invalidateDefinitionsCache(input.cache, {
      tenantId: input.tenantId,
      organizationId: null,
      entityIds: [PERSON_PROFILE_ENTITY_ID],
    })
  }

  const definitions = await input.em.find(CustomFieldDef, {
    entityId: PERSON_PROFILE_ENTITY_ID,
    tenantId: input.tenantId,
    organizationId: null,
    key: { $in: retentionFields.map((field) => field.key) },
    isActive: true,
    deletedAt: null,
  })
  if (definitions.length !== retentionFields.length) {
    throw new Error('[internal] Finoo retention custom-field definition readback count mismatch')
  }

  for (const field of retentionFields) {
    const definition = definitions.find((candidate) => candidate.key === field.key)
    if (
      !definition
      || definition.kind !== field.kind
      || JSON.stringify(normalizeValue(definition.configJson))
        !== JSON.stringify(normalizeValue(expectedConfig(field)))
    ) {
      throw new Error(`[internal] Finoo retention custom-field definition readback mismatch: ${field.key}`)
    }
  }

  return { ...result, verified: definitions.length }
}
