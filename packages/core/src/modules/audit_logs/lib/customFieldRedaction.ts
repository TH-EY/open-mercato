import type { EntityManager } from '@mikro-orm/postgresql'
import { CustomFieldDef } from '@open-mercato/core/modules/entities/data/entities'
import { CUSTOMER_ENTITY_ID, PERSON_ENTITY_ID } from '@open-mercato/core/modules/customers/lib/customFieldRouting'

type ActionLogLike = {
  resourceKind?: string | null
  tenantId?: string | null
  organizationId?: string | null
  commandPayload?: unknown
  snapshotBefore?: unknown
  snapshotAfter?: unknown
  changesJson?: Record<string, unknown> | null
  contextJson?: Record<string, unknown> | null
}

type RedactionScope = {
  tenantId: string
  organizationId: string
}

const PERSON_CUSTOM_FIELD_ENTITIES = [CUSTOMER_ENTITY_ID, PERSON_ENTITY_ID] as const
const SKIP = Symbol('skip-inactive-custom-field')

function scopeKey(scope: RedactionScope): string {
  return `${scope.tenantId}:${scope.organizationId}`
}

function definitionScopeRank(definition: CustomFieldDef, scope: RedactionScope): number {
  if (definition.organizationId === scope.organizationId && definition.tenantId === scope.tenantId) return 4
  if (definition.organizationId === scope.organizationId && definition.tenantId == null) return 3
  if (definition.organizationId == null && definition.tenantId === scope.tenantId) return 2
  if (definition.organizationId == null && definition.tenantId == null) return 1
  return -1
}

function inactiveKeysForScope(definitions: CustomFieldDef[], scope: RedactionScope): Set<string> {
  const selected = new Map<string, { definition: CustomFieldDef; rank: number }>()
  for (const definition of definitions) {
    const rank = definitionScopeRank(definition, scope)
    if (rank < 0) continue
    const selectionKey = `${definition.entityId}:${definition.key}`
    const previous = selected.get(selectionKey)
    if (!previous || rank > previous.rank) {
      selected.set(selectionKey, { definition, rank })
      continue
    }
    if (rank < previous.rank) continue
    const nextTime =
      definition.updatedAt instanceof Date ? definition.updatedAt.getTime() : new Date(definition.updatedAt).getTime()
    const previousTime =
      previous.definition.updatedAt instanceof Date
        ? previous.definition.updatedAt.getTime()
        : new Date(previous.definition.updatedAt).getTime()
    if (nextTime >= previousTime) selected.set(selectionKey, { definition, rank })
  }

  const blocked = new Set<string>()
  for (const { definition } of selected.values()) {
    if (definition.isActive === false || definition.deletedAt) blocked.add(definition.key)
  }
  return blocked
}

function canonicalPathSegments(rawKey: string): string[] {
  return rawKey.split('.').map((segment) => {
    let normalized = segment
    while (normalized.startsWith('cf_') || normalized.startsWith('cf:')) {
      normalized = normalized.slice(3)
    }
    return normalized
  })
}

function containsBlockedKey(rawKey: string, blocked: Set<string>): boolean {
  return canonicalPathSegments(rawKey).some((segment) => blocked.has(segment))
}

function redactValue(value: unknown, blocked: Set<string>): unknown | typeof SKIP {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      if (
        entry &&
        typeof entry === 'object' &&
        !Array.isArray(entry) &&
        typeof (entry as Record<string, unknown>).key === 'string' &&
        containsBlockedKey((entry as Record<string, unknown>).key as string, blocked)
      ) {
        return []
      }
      const redacted = redactValue(entry, blocked)
      return redacted === SKIP ? [] : [redacted]
    })
  }
  if (!value || typeof value !== 'object' || value instanceof Date) return value
  const result: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (containsBlockedKey(key, blocked)) continue
    const redacted = redactValue(nested, blocked)
    if (redacted !== SKIP) result[key] = redacted
  }
  return result
}

export function redactCustomFieldKeysFromActionLog<TEntry extends ActionLogLike>(
  entry: TEntry,
  blocked: Set<string>,
): TEntry {
  if (blocked.size === 0) return entry
  return {
    ...entry,
    commandPayload: redactValue(entry.commandPayload, blocked),
    snapshotBefore: redactValue(entry.snapshotBefore, blocked),
    snapshotAfter: redactValue(entry.snapshotAfter, blocked),
    changesJson: redactValue(entry.changesJson, blocked) as Record<string, unknown> | null,
    contextJson: redactValue(entry.contextJson, blocked) as Record<string, unknown> | null,
  }
}

export async function redactInactiveCustomFieldsFromActionLogs<TEntry extends ActionLogLike>(
  em: EntityManager,
  entries: TEntry[],
): Promise<TEntry[]> {
  const scopes = new Map<string, RedactionScope>()
  for (const entry of entries) {
    if (
      entry.resourceKind === 'customers.person' &&
      typeof entry.tenantId === 'string' &&
      typeof entry.organizationId === 'string'
    ) {
      const scope = {
        tenantId: entry.tenantId,
        organizationId: entry.organizationId,
      }
      scopes.set(scopeKey(scope), scope)
    }
  }
  if (scopes.size === 0) return entries

  const blockedByScope = new Map<string, Set<string>>()
  await Promise.all(
    Array.from(scopes.values()).map(async (scope) => {
      const definitions = await em.find(CustomFieldDef, {
        entityId: { $in: [...PERSON_CUSTOM_FIELD_ENTITIES] },
        tenantId: { $in: [scope.tenantId, null] as never },
        organizationId: { $in: [scope.organizationId, null] as never },
      })
      blockedByScope.set(scopeKey(scope), inactiveKeysForScope(definitions, scope))
    }),
  )

  return entries.map((entry) => {
    if (
      entry.resourceKind !== 'customers.person' ||
      typeof entry.tenantId !== 'string' ||
      typeof entry.organizationId !== 'string'
    )
      return entry
    const blocked = blockedByScope.get(
      scopeKey({
        tenantId: entry.tenantId,
        organizationId: entry.organizationId,
      }),
    )
    if (!blocked || blocked.size === 0) return entry
    return redactCustomFieldKeysFromActionLog(entry, blocked)
  })
}
