import { Badge } from '@open-mercato/ui/primitives/badge'
import { isRecord, type SchemaFieldHint } from '../../lib/endpoint-schema'

export interface EndpointPickerParam {
  name: string
  in: 'path' | 'query' | 'header'
  required: boolean
  type: string
}

export interface EndpointPickerItem {
  path: string
  method: string
  summary: string
  tag: string
  params: EndpointPickerParam[]
  hasRequestSchema: boolean
  requestSchema?: Record<string, unknown>
  responseSchema?: Record<string, unknown>
}

export interface EndpointPickerProps {
  id: string
  endpoint: string
  method: string
  headers?: Record<string, unknown>
  onApply: (patch: Record<string, unknown>) => void
  disabled?: boolean
}

export function groupEndpointPickerItems(
  items: EndpointPickerItem[],
): Array<{ tag: string; items: EndpointPickerItem[] }> {
  const groups = new Map<string, EndpointPickerItem[]>()
  for (const item of items) {
    groups.set(item.tag, [...(groups.get(item.tag) ?? []), item])
  }
  return Array.from(groups.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([tag, tagItems]) => ({ tag, items: tagItems }))
}

export function orderEndpointPickerParams(params: EndpointPickerParam[]): EndpointPickerParam[] {
  const locationRank = { path: 0, query: 1, header: 2 }
  return [...params].sort((left, right) => {
    if (left.required !== right.required) return left.required ? -1 : 1
    if (left.in !== right.in) return locationRank[left.in] - locationRank[right.in]
    return left.name.localeCompare(right.name)
  })
}

export function endpointPickerStringRecord(
  value: Record<string, unknown> | undefined,
): Record<string, string> {
  if (!value) return {}
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
}

export function endpointPickerHeaders(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

export function EndpointSchemaHints({
  title,
  hints,
  emptyText,
}: {
  title: string
  hints: SchemaFieldHint[]
  emptyText: string
}) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium">{title}</p>
      {hints.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {hints.map((hint) => (
            <Badge key={hint.name} variant="secondary" className="font-mono text-xs">
              {hint.name}{hint.required ? '*' : ''}: {hint.type}
            </Badge>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{emptyText}</p>
      )}
    </div>
  )
}
