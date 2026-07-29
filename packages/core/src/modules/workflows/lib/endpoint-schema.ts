export interface SchemaFieldHint {
  name: string
  type: string
  required: boolean
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function schemaType(schema: unknown): string {
  if (!isRecord(schema)) return 'unknown'
  if (typeof schema.type === 'string' && schema.type.length > 0) return schema.type
  if (Array.isArray(schema.type)) return schema.type.filter((value) => typeof value === 'string').join(' | ')
  if (Array.isArray(schema.oneOf)) return 'union'
  return 'unknown'
}

export function schemaFieldHints(schema: Record<string, unknown> | undefined): SchemaFieldHint[] {
  if (!schema) return []
  const properties = schema.properties
  if (!isRecord(properties)) return []
  const required = Array.isArray(schema.required)
    ? schema.required.filter((name): name is string => typeof name === 'string')
    : []

  return Object.entries(properties).map(([name, propertySchema]) => ({
    name,
    type: schemaType(propertySchema),
    required: required.includes(name),
  }))
}
