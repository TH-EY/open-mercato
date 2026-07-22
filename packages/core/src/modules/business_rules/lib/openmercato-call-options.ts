import type { EntityManager } from '@mikro-orm/postgresql'
import {
  getApiRouteManifests,
  type ApiRouteManifestEntry,
  type Module,
} from '@open-mercato/shared/modules/registry'
import { getModules } from '@open-mercato/shared/lib/modules/registry'
import { buildOpenApiDocument } from '@open-mercato/shared/lib/openapi'
import type { OpenApiMethodDoc, OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { findOneWithDecryption, findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { forbidden } from '@open-mercato/shared/lib/crud/errors'
import { assertActorCanGrantRoles } from '../../auth/lib/grantChecks'
import type { RbacService } from '../../auth/services/rbacService'
import { ApiKey } from '../../api_keys/data/entities'
import { Role, User } from '../../auth/data/entities'
import { Organization } from '../../directory/data/entities'
import {
  OPENMERCATO_CALL_METHODS,
  type OpenMercatoApiKeyOption,
  type OpenMercatoCallMethod,
  type OpenMercatoEndpointOption,
} from './openmercato-call-options-types'

export type OpenMercatoCallScope = {
  tenantId: string
  organizationId?: string | null
}

export type OpenMercatoCallGrantContext = {
  actorUserId?: string | null
  rbacService: RbacService
}

export type GrantableOpenMercatoApiKeyProfile = {
  apiKey: ApiKey
  roleIds: string[]
  roles: Role[]
}

const METHOD_ORDER = new Map<string, number>(
  OPENMERCATO_CALL_METHODS.map((method, index) => [method, index]),
)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const BLOCKED_ENDPOINTS = new Set([
  '/api/business_rules/execute',
  '/api/business_rules/openmercato-call-options',
])
const BLOCKED_ENDPOINT_PREFIXES = [
  '/api/api_keys',
  '/api/auth',
]

function isOpenMercatoCallMethod(value: string): value is OpenMercatoCallMethod {
  return OPENMERCATO_CALL_METHODS.includes(value as OpenMercatoCallMethod)
}

function hasPathSegment(path: string, segment: string): boolean {
  return path.split('/').filter(Boolean).includes(segment)
}

function isBlockedEndpoint(path: string): boolean {
  if (BLOCKED_ENDPOINTS.has(path)) return true
  return BLOCKED_ENDPOINT_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
}

function shouldExposeEndpoint(path: string, method: string, operation: Record<string, any>): boolean {
  if (!isOpenMercatoCallMethod(method.toUpperCase())) return false
  if (!path.startsWith('/api/')) return false
  if (path.includes('{')) return false
  if (path.includes('[')) return false
  if (path.startsWith('/api/docs')) return false
  if (isBlockedEndpoint(path)) return false
  if (hasPathSegment(path, 'options')) return false
  if (operation.deprecated === true) return false
  return true
}

export function dedupeOpenMercatoEndpointOptions(
  options: OpenMercatoEndpointOption[],
): OpenMercatoEndpointOption[] {
  const deduped = new Map<string, OpenMercatoEndpointOption>()

  for (const option of options) {
    const existing = deduped.get(option.id)
    if (!existing) {
      deduped.set(option.id, option)
      continue
    }

    if ((!existing.summary && option.summary) || (!existing.operationId && option.operationId)) {
      deduped.set(option.id, {
        ...existing,
        label: option.label,
        summary: option.summary ?? existing.summary,
        operationId: option.operationId ?? existing.operationId,
      })
    }
  }

  return Array.from(deduped.values())
}

function sortEndpointOptions(options: OpenMercatoEndpointOption[]): OpenMercatoEndpointOption[] {
  return dedupeOpenMercatoEndpointOptions(options).sort((a, b) => {
    const pathCompare = a.path.localeCompare(b.path)
    if (pathCompare !== 0) return pathCompare
    return (METHOD_ORDER.get(a.method) ?? 99) - (METHOD_ORDER.get(b.method) ?? 99)
  })
}

export function collectOpenMercatoEndpointOptionsFromDocument(doc: { paths?: Record<string, any> }): OpenMercatoEndpointOption[] {
  const options: OpenMercatoEndpointOption[] = []

  for (const [path, methods] of Object.entries(doc.paths ?? {})) {
    for (const [rawMethod, operation] of Object.entries(methods ?? {})) {
      const method = rawMethod.toUpperCase()
      if (!operation || typeof operation !== 'object') continue
      if (!shouldExposeEndpoint(path, method, operation as Record<string, any>)) continue

      const typedMethod = method as OpenMercatoCallMethod
      const summary = typeof (operation as any).summary === 'string' ? (operation as any).summary : null
      const operationId = typeof (operation as any).operationId === 'string' ? (operation as any).operationId : null

      options.push({
        id: `${typedMethod} ${path}`,
        path,
        method: typedMethod,
        label: summary ? `${typedMethod} ${path} - ${summary}` : `${typedMethod} ${path}`,
        summary,
        operationId,
      })
    }
  }

  return sortEndpointOptions(options)
}

export function collectOpenMercatoEndpointOptions(modules: Module[]): OpenMercatoEndpointOption[] {
  return collectOpenMercatoEndpointOptionsFromDocument(buildOpenApiDocument(modules))
}

function normalizeManifestPath(path: string): string {
  const prefixed = path.startsWith('/api/') ? path : `/api${path.startsWith('/') ? path : `/${path}`}`
  return prefixed.replace(/\/+$/, '') || '/api'
}

function getRouteMethodDoc(routeDoc: OpenApiRouteDoc | undefined, method: OpenMercatoCallMethod): OpenApiMethodDoc | undefined {
  return routeDoc?.methods?.[method]
}

async function collectOpenMercatoEndpointOptionsFromApiRouteManifests(
  routes: ApiRouteManifestEntry[],
): Promise<OpenMercatoEndpointOption[]> {
  const options: OpenMercatoEndpointOption[] = []

  for (const route of routes) {
    const path = normalizeManifestPath(route.path)
    const candidateMethods = route.methods
      .map((method) => method.toUpperCase())
      .filter(isOpenMercatoCallMethod)
    if (candidateMethods.length === 0) continue
    if (!path.startsWith('/api/')) continue
    if (path.includes('[')) continue
    if (path.startsWith('/api/docs')) continue
    if (isBlockedEndpoint(path)) continue
    if (hasPathSegment(path, 'options')) continue

    let routeDoc: OpenApiRouteDoc | undefined
    try {
      const routeModule = await route.load()
      routeDoc = routeModule.openApi as OpenApiRouteDoc | undefined
    } catch {
      routeDoc = undefined
    }

    for (const typedMethod of candidateMethods) {
      const methodDoc = getRouteMethodDoc(routeDoc, typedMethod)
      const operation = methodDoc ?? {}
      if (!shouldExposeEndpoint(path, typedMethod, operation as Record<string, any>)) continue

      const summary = typeof methodDoc?.summary === 'string' ? methodDoc.summary : null
      const operationId = typeof methodDoc?.operationId === 'string' ? methodDoc.operationId : null
      options.push({
        id: `${typedMethod} ${path}`,
        path,
        method: typedMethod,
        label: summary ? `${typedMethod} ${path} - ${summary}` : `${typedMethod} ${path}`,
        summary,
        operationId,
      })
    }
  }

  return sortEndpointOptions(options)
}

export async function getCurrentOpenMercatoEndpointOptions(): Promise<OpenMercatoEndpointOption[]> {
  try {
    const moduleOptions = collectOpenMercatoEndpointOptions(getModules())
    if (moduleOptions.length > 0) return moduleOptions
  } catch {
    // The runtime app route registry is the source of truth when modules were not
    // registered in this package instance.
  }

  const apiRoutes = getApiRouteManifests()
  if (apiRoutes.length === 0) return []
  return collectOpenMercatoEndpointOptionsFromApiRouteManifests(apiRoutes)
}

export function findOpenMercatoEndpointOption(
  endpoint: string,
  method: string,
  options: OpenMercatoEndpointOption[],
): OpenMercatoEndpointOption | null {
  const normalizedMethod = method.trim().toUpperCase()
  if (!endpoint.startsWith('/api/')) return null
  if (!isOpenMercatoCallMethod(normalizedMethod)) return null
  return options.find((option) => option.path === endpoint && option.method === normalizedMethod) ?? null
}

function getApiKeyProfileRoleIds(apiKey: ApiKey): string[] {
  return Array.isArray(apiKey.rolesJson)
    ? apiKey.rolesJson.filter((roleId): roleId is string => typeof roleId === 'string' && roleId.length > 0)
    : []
}

async function loadApiKeyProfileRoles(
  em: EntityManager,
  roleIds: string[],
  scope: OpenMercatoCallScope,
): Promise<Role[]> {
  if (roleIds.length === 0) {
    throw forbidden('CALL_OPEN_MERCATO action requires an API key profile with at least one role.')
  }

  const roles = await findWithDecryption(
    em,
    Role,
    { id: { $in: roleIds }, tenantId: scope.tenantId, deletedAt: null },
    {},
    { tenantId: scope.tenantId, organizationId: null },
  )
  const foundIds = new Set(roles.map((role) => String(role.id)))
  if (roleIds.some((roleId) => !foundIds.has(roleId))) {
    throw forbidden('CALL_OPEN_MERCATO selected API key profile contains unavailable roles.')
  }

  return roles
}

async function assertOpenMercatoGrantorIsActive(
  em: EntityManager,
  scope: OpenMercatoCallScope,
  actorUserId?: string | null,
): Promise<string> {
  const grantorId = typeof actorUserId === 'string' ? actorUserId.trim() : ''
  if (!grantorId || grantorId.startsWith('api_key:')) {
    throw forbidden('CALL_OPEN_MERCATO action requires an accountable active user grantor.')
  }

  const grantor = await findOneWithDecryption(
    em,
    User,
    {
      id: grantorId,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId ?? null,
      deletedAt: null,
    },
    {},
    { tenantId: scope.tenantId, organizationId: scope.organizationId ?? null },
  )
  if (!grantor) {
    throw forbidden('CALL_OPEN_MERCATO action requires an accountable active user grantor in scope.')
  }

  return grantorId
}

export async function assertOpenMercatoApiKeyProfileGrantable(
  em: EntityManager,
  apiKey: ApiKey,
  scope: OpenMercatoCallScope,
  grantContext: OpenMercatoCallGrantContext,
): Promise<GrantableOpenMercatoApiKeyProfile> {
  const actorUserId = await assertOpenMercatoGrantorIsActive(em, scope, grantContext.actorUserId)
  const roleIds = getApiKeyProfileRoleIds(apiKey)
  const roles = await loadApiKeyProfileRoles(em, roleIds, scope)

  await assertActorCanGrantRoles({
    em,
    rbacService: grantContext.rbacService,
    actorUserId,
    tenantId: scope.tenantId,
    organizationId: scope.organizationId ?? null,
    roles,
  })

  return { apiKey, roleIds, roles }
}

export async function listOpenMercatoApiKeyOptions(
  em: EntityManager,
  scope: OpenMercatoCallScope,
  grantContext?: OpenMercatoCallGrantContext,
): Promise<OpenMercatoApiKeyOption[]> {
  const filters: Record<string, any> = {
    tenantId: scope.tenantId,
    deletedAt: null,
  }
  if (scope.organizationId) {
    filters.organizationId = scope.organizationId
  }

  const decryptionScope = { tenantId: scope.tenantId, organizationId: scope.organizationId ?? null }
  const keys = await findWithDecryption(em, ApiKey, filters, { orderBy: { name: 'asc' } }, decryptionScope)
  const now = Date.now()
  const activeKeys = keys.filter((key) => !key.expiresAt || key.expiresAt.getTime() > now)
  const grantableKeys: ApiKey[] = []

  const roleIds = new Set<string>()
  const organizationIds = new Set<string>()
  for (const key of activeKeys) {
    if (key.organizationId) organizationIds.add(String(key.organizationId))
    if (Array.isArray(key.rolesJson)) {
      for (const roleId of key.rolesJson) roleIds.add(String(roleId))
    }
  }

  const [roles, organizations] = await Promise.all([
    roleIds.size > 0
      ? findWithDecryption(em, Role, { id: { $in: Array.from(roleIds) }, tenantId: scope.tenantId, deletedAt: null }, {}, decryptionScope)
      : [],
    organizationIds.size > 0
      ? findWithDecryption(em, Organization, { id: { $in: Array.from(organizationIds) } }, {}, decryptionScope)
      : [],
  ])
  const roleMap = new Map((roles as Role[]).map((role) => [String(role.id), role.name ?? null]))
  const orgMap = new Map((organizations as Organization[]).map((org) => [String(org.id), org.name ?? null]))

  if (grantContext) {
    for (const key of activeKeys) {
      try {
        await assertOpenMercatoApiKeyProfileGrantable(em, key, scope, grantContext)
        grantableKeys.push(key)
      } catch {
        // Fail closed in the picker: profiles the actor cannot grant are hidden.
      }
    }
  }

  const visibleKeys = grantContext ? grantableKeys : activeKeys

  return visibleKeys.map((key) => ({
    id: key.id,
    name: key.name,
    keyPrefix: key.keyPrefix,
    organizationId: key.organizationId ?? null,
    organizationName: key.organizationId ? orgMap.get(String(key.organizationId)) ?? null : null,
    roles: Array.isArray(key.rolesJson)
      ? key.rolesJson.map((roleId) => ({
          id: String(roleId),
          name: roleMap.get(String(roleId)) ?? null,
        }))
      : [],
  }))
}

export async function resolveOpenMercatoApiKeyProfile(
  em: EntityManager,
  apiKeyId: string,
  scope: OpenMercatoCallScope,
): Promise<ApiKey | null> {
  if (!apiKeyId || typeof apiKeyId !== 'string') return null
  if (!UUID_RE.test(apiKeyId)) return null
  const filters: Record<string, any> = {
    id: apiKeyId,
    tenantId: scope.tenantId,
    deletedAt: null,
  }
  if (scope.organizationId) {
    filters.organizationId = scope.organizationId
  }

  const key = await findOneWithDecryption(
    em,
    ApiKey,
    filters,
    {},
    { tenantId: scope.tenantId, organizationId: scope.organizationId ?? null },
  )
  if (!key) return null
  if (key.expiresAt && key.expiresAt.getTime() <= Date.now()) return null
  return key
}

export async function validateOpenMercatoCallActions(
  em: EntityManager,
  actions: unknown,
  scope: OpenMercatoCallScope,
  endpointOptions?: OpenMercatoEndpointOption[],
  grantContext?: OpenMercatoCallGrantContext,
): Promise<string[]> {
  if (!Array.isArray(actions) || actions.length === 0) return []

  const errors: string[] = []
  let availableEndpointOptions = endpointOptions
  for (const [index, action] of actions.entries()) {
    if (!action || typeof action !== 'object') continue
    const typedAction = action as { type?: string; config?: Record<string, any> }
    if (typedAction.type !== 'CALL_OPEN_MERCATO') continue
    availableEndpointOptions ??= await getCurrentOpenMercatoEndpointOptions()

    const config = typedAction.config ?? {}
    const endpoint = typeof config.endpoint === 'string' ? config.endpoint : ''
    const method = typeof config.method === 'string' ? config.method : ''
    const apiKeyId = typeof config.apiKeyId === 'string' ? config.apiKeyId : ''

    if (!findOpenMercatoEndpointOption(endpoint, method, availableEndpointOptions)) {
      errors.push(`Action ${index + 1}: selected OpenMercato endpoint is not available`)
    }

    const apiKey = await resolveOpenMercatoApiKeyProfile(em, apiKeyId, scope)
    if (!apiKey) {
      errors.push(`Action ${index + 1}: selected API key profile is not available`)
    } else if (!Array.isArray(apiKey.rolesJson) || apiKey.rolesJson.length === 0) {
      errors.push(`Action ${index + 1}: selected API key profile has no roles`)
    } else if (grantContext) {
      await assertOpenMercatoApiKeyProfileGrantable(em, apiKey, scope, grantContext)
    }
  }

  return errors
}
