const PATH_SEGMENT = /^[A-Za-z0-9_-]+$/
const UNSAFE_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor'])
const MAX_CORRELATION_KEY_LENGTH = 255

function correlationPathSegments(path: string): string[] | null {
  if (!path || path.length > 500) return null

  const segments = path.split('.')
  if (segments.some((segment) => !PATH_SEGMENT.test(segment) || UNSAFE_SEGMENTS.has(segment))) {
    return null
  }

  return segments
}

export function readCorrelationScalar(source: unknown, path: string): string | null {
  const segments = correlationPathSegments(path)
  if (!segments) return null

  let value: unknown = source
  for (const segment of segments) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    if (!Object.prototype.hasOwnProperty.call(value, segment)) return null
    value = (value as Record<string, unknown>)[segment]
  }

  if (typeof value === 'string') {
    return value.length > 0 && value.length <= MAX_CORRELATION_KEY_LENGTH ? value : null
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return String(value)
  return null
}
