import type { ApiRouteManifestEntry, Module } from '@open-mercato/shared/modules/registry'
import { getApiRouteManifests } from '@open-mercato/shared/modules/registry'
import { getModules } from '@open-mercato/shared/lib/modules/registry'
import {
  attachOpenApiDocsToModules,
  buildOpenApiDocument,
} from '@open-mercato/shared/lib/openapi'
import { isRecord } from './endpoint-schema'

export type WorkflowEndpointParamLocation = 'path' | 'query' | 'header'

export interface WorkflowEndpointParam {
  name: string
  in: WorkflowEndpointParamLocation
  required: boolean
  type: string
}

export interface WorkflowEndpointDescriptor {
  path: string
  method: string
  summary: string
  tag: string
  params: WorkflowEndpointParam[]
  hasRequestSchema: boolean
  requestSchema?: Record<string, unknown>
  responseSchema?: Record<string, unknown>
}

export interface WorkflowEndpointCatalog {
  items: WorkflowEndpointDescriptor[]
}

const METHOD_ORDER = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const
const PARAM_LOCATIONS = new Set<WorkflowEndpointParamLocation>(['path', 'query', 'header'])
const UNDECLARED_RESPONSE_DESCRIPTION = 'Schema not declared'

function methodRank(method: string): number {
  const index = METHOD_ORDER.indexOf(method as (typeof METHOD_ORDER)[number])
  return index === -1 ? METHOD_ORDER.length : index
}

function schemaTypeOf(schema: unknown): string {
  if (!isRecord(schema)) return 'unknown'
  return typeof schema.type === 'string' && schema.type.length > 0 ? schema.type : 'unknown'
}

function projectParams(parameters: unknown): WorkflowEndpointParam[] {
  if (!Array.isArray(parameters)) return []
  const params: WorkflowEndpointParam[] = []

  for (const parameter of parameters) {
    if (!isRecord(parameter)) continue
    const name = parameter.name
    const location = parameter.in
    if (typeof name !== 'string' || name.length === 0) continue
    if (typeof location !== 'string' || !PARAM_LOCATIONS.has(location as WorkflowEndpointParamLocation)) continue

    params.push({
      name,
      in: location as WorkflowEndpointParamLocation,
      required: parameter.required === true,
      type: schemaTypeOf(parameter.schema),
    })
  }

  return params
}

function jsonContentSchema(container: unknown): Record<string, unknown> | undefined {
  if (!isRecord(container)) return undefined
  const content = container.content
  if (!isRecord(content)) return undefined
  const jsonEntry = content['application/json']
  if (!isRecord(jsonEntry)) return undefined
  const schema = jsonEntry.schema
  if (!isRecord(schema) || Object.keys(schema).length === 0) return undefined
  return schema
}

function isDeclaredResponseSchema(schema: Record<string, unknown>): boolean {
  if (schema.type === 'object' && (!isRecord(schema.properties) || Object.keys(schema.properties).length === 0)) {
    return false
  }
  if (schema.description !== UNDECLARED_RESPONSE_DESCRIPTION) return true
  if (isRecord(schema.properties) && Object.keys(schema.properties).length > 0) return true
  return schema.type !== 'object'
}

function projectSuccessResponseSchema(responses: unknown): Record<string, unknown> | undefined {
  if (!isRecord(responses)) return undefined
  const successStatuses = Object.keys(responses)
    .map((status) => Number.parseInt(status, 10))
    .filter((status) => Number.isInteger(status) && status >= 200 && status < 300)
    .sort((left, right) => left - right)

  for (const status of successStatuses) {
    const schema = jsonContentSchema(responses[String(status)])
    if (schema && isDeclaredResponseSchema(schema)) return schema
  }

  return undefined
}

export function buildEndpointCatalog(modules: Module[]): WorkflowEndpointCatalog {
  const document = buildOpenApiDocument(modules)
  const items: WorkflowEndpointDescriptor[] = []

  for (const [documentPath, operations] of Object.entries(document.paths)) {
    if (!isRecord(operations)) continue

    for (const [methodLower, operation] of Object.entries(operations)) {
      const method = methodLower.toUpperCase()
      if (methodRank(method) === METHOD_ORDER.length || !isRecord(operation)) continue

      const requestSchema = jsonContentSchema(operation.requestBody)
      const responseSchema = projectSuccessResponseSchema(operation.responses)
      const tags = operation.tags

      items.push({
        path: `/api${documentPath}`,
        method,
        summary:
          typeof operation.summary === 'string' && operation.summary.length > 0
            ? operation.summary
            : `${method} /api${documentPath}`,
        tag: Array.isArray(tags) && typeof tags[0] === 'string' ? tags[0] : '',
        params: projectParams(operation.parameters),
        hasRequestSchema: requestSchema !== undefined,
        ...(requestSchema ? { requestSchema } : {}),
        ...(responseSchema ? { responseSchema } : {}),
      })
    }
  }

  items.sort((left, right) => {
    const byPath = left.path.localeCompare(right.path)
    return byPath !== 0 ? byPath : methodRank(left.method) - methodRank(right.method)
  })

  return { items }
}

let catalogPromise: Promise<WorkflowEndpointCatalog> | null = null

async function assembleCatalog(
  apiRouteManifests: ApiRouteManifestEntry[],
): Promise<WorkflowEndpointCatalog> {
  const modules = await attachOpenApiDocsToModules(getModules(), apiRouteManifests)
  return buildEndpointCatalog(modules)
}

export async function getWorkflowEndpointCatalog(
  apiRouteManifests: ApiRouteManifestEntry[] = getApiRouteManifests(),
): Promise<WorkflowEndpointCatalog> {
  if (!catalogPromise) {
    catalogPromise = assembleCatalog(apiRouteManifests).catch((error: unknown) => {
      catalogPromise = null
      throw error
    })
  }
  return catalogPromise
}

export function clearWorkflowEndpointCatalogForTests(): void {
  catalogPromise = null
}
