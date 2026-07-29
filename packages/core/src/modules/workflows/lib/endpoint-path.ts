export interface EndpointValueParts {
  path: string
  query: Record<string, string>
}

export interface EndpointTemplateMatch {
  pathParams: Record<string, string>
}

export interface MatchableEndpoint {
  path: string
  method: string
}

const REQUIRED_PLACEHOLDER_PREFIX = '__om_required_'
const WORKFLOW_TOKEN_PATTERN = /(\{\{[^{}]+\}\})/g

function stripTrailingSlash(path: string): string {
  if (path.length > 1 && path.endsWith('/')) return path.slice(0, -1)
  return path
}

function templateParamName(segment: string): string | null {
  if (segment.startsWith('{{') && segment.endsWith('}}')) return null
  if (segment.length > 2 && segment.startsWith('{') && segment.endsWith('}')) {
    return segment.slice(1, -1)
  }
  return null
}

function decodeEndpointComponent(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function encodeEndpointComponent(value: string): string {
  const placeholderName = templateParamName(value)
  if (placeholderName?.startsWith(REQUIRED_PLACEHOLDER_PREFIX)) return value
  return value
    .split(WORKFLOW_TOKEN_PATTERN)
    .map((part) => part.startsWith('{{') && part.endsWith('}}') ? part : encodeURIComponent(part))
    .join('')
}

export function requiredEndpointParamPlaceholder(name: string): string {
  return `{${REQUIRED_PLACEHOLDER_PREFIX}${name}}`
}

export function unresolvedRequiredEndpointParamName(value: string): string | null {
  const name = templateParamName(value)
  return name?.startsWith(REQUIRED_PLACEHOLDER_PREFIX)
    ? name.slice(REQUIRED_PLACEHOLDER_PREFIX.length)
    : null
}

export function splitEndpointValue(value: string): EndpointValueParts {
  const trimmed = value.trim()
  const queryIndex = trimmed.indexOf('?')
  const path = stripTrailingSlash(queryIndex === -1 ? trimmed : trimmed.slice(0, queryIndex))
  const query: Record<string, string> = {}

  if (queryIndex !== -1) {
    for (const pair of trimmed.slice(queryIndex + 1).split('&')) {
      if (pair.length === 0) continue
      const equalsIndex = pair.indexOf('=')
      const key = decodeEndpointComponent(equalsIndex === -1 ? pair : pair.slice(0, equalsIndex))
      if (key.length === 0) continue
      query[key] = equalsIndex === -1 ? '' : decodeEndpointComponent(pair.slice(equalsIndex + 1))
    }
  }

  return { path, query }
}

export function matchEndpointTemplate(endpointPath: string, templatePath: string): EndpointTemplateMatch | null {
  const valueSegments = stripTrailingSlash(endpointPath.trim()).split('/')
  const templateSegments = stripTrailingSlash(templatePath.trim()).split('/')
  if (valueSegments.length !== templateSegments.length) return null

  const pathParams: Record<string, string> = {}
  for (let index = 0; index < templateSegments.length; index += 1) {
    const templateSegment = templateSegments[index]
    const valueSegment = valueSegments[index]
    const paramName = templateParamName(templateSegment)

    if (paramName !== null) {
      if (valueSegment.length === 0) return null
      pathParams[paramName] = valueSegment === `{${paramName}}`
        ? ''
        : decodeEndpointComponent(valueSegment)
      continue
    }

    if (templateSegment !== valueSegment) return null
  }

  return { pathParams }
}

function templateParamCount(templatePath: string): number {
  return templatePath
    .split('/')
    .filter((segment) => templateParamName(segment) !== null)
    .length
}

export function findMatchingEndpoint<T extends MatchableEndpoint>(
  endpointValue: string,
  method: string,
  items: T[],
): { item: T; match: EndpointTemplateMatch } | null {
  const { path } = splitEndpointValue(endpointValue)
  if (path.length === 0) return null

  const normalizedMethod = method.trim().toUpperCase()
  const candidates: Array<{ item: T; match: EndpointTemplateMatch; paramCount: number }> = []

  for (const item of items) {
    if (item.method.toUpperCase() !== normalizedMethod) continue
    const match = matchEndpointTemplate(path, item.path)
    if (!match) continue
    candidates.push({ item, match, paramCount: templateParamCount(item.path) })
  }

  candidates.sort((left, right) => {
    if (left.paramCount !== right.paramCount) return left.paramCount - right.paramCount
    return left.item.path.localeCompare(right.item.path)
  })

  const best = candidates[0]
  return best ? { item: best.item, match: best.match } : null
}

export function composeEndpointValue(
  templatePath: string,
  pathParams: Record<string, string>,
  queryParams: Record<string, string>,
  omittedPathParams: string[] = [],
): string {
  const omittedPathParamNames = new Set(omittedPathParams)
  const path = stripTrailingSlash(templatePath.trim())
    .split('/')
    .flatMap((segment) => {
      const paramName = templateParamName(segment)
      if (paramName === null) return [segment]
      const value = pathParams[paramName]
      if (typeof value === 'string' && value.length > 0) return [encodeEndpointComponent(value)]
      return omittedPathParamNames.has(paramName) ? [] : [segment]
    })
    .join('/')
  const queryEntries = Object.entries(queryParams).filter(([key, value]) => key.length > 0 && value.length > 0)
  if (queryEntries.length === 0) return path
  return `${path}?${queryEntries
    .map(([key, value]) => `${encodeEndpointComponent(key)}=${encodeEndpointComponent(value)}`)
    .join('&')}`
}

export function findUnresolvedEndpointParams(endpoint: string): string[] {
  const { path, query } = splitEndpointValue(endpoint)
  const unresolved = path
    .split('/')
    .map((segment) => unresolvedRequiredEndpointParamName(decodeEndpointComponent(segment)))
    .filter((name): name is string => name !== null)

  for (const value of Object.values(query)) {
    const name = unresolvedRequiredEndpointParamName(value)
    if (name !== null) unresolved.push(name)
  }

  return Array.from(new Set(unresolved))
}
