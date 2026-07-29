'use client'

import * as React from 'react'
import { Globe } from 'lucide-react'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { Badge } from '@open-mercato/ui/primitives/badge'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { Label } from '@open-mercato/ui/primitives/label'
import { Popover, PopoverContent, PopoverTrigger } from '@open-mercato/ui/primitives/popover'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import {
  composeEndpointValue,
  findMatchingEndpoint,
  requiredEndpointParamPlaceholder,
  splitEndpointValue,
  unresolvedRequiredEndpointParamName,
} from '../../lib/endpoint-path'
import { schemaFieldHints } from '../../lib/endpoint-schema'
import {
  EndpointSchemaHints,
  endpointPickerHeaders,
  endpointPickerStringRecord,
  groupEndpointPickerItems,
  orderEndpointPickerParams,
  type EndpointPickerItem,
  type EndpointPickerParam,
  type EndpointPickerProps,
} from './EndpointPickerParts'

export { endpointPickerHeaders }
export type { EndpointPickerItem, EndpointPickerParam }

export function EndpointPicker({
  id,
  endpoint,
  method,
  headers,
  onApply,
  disabled,
}: EndpointPickerProps) {
  const t = useT()
  const [items, setItems] = React.useState<EndpointPickerItem[] | null>(null)
  const [lookupFailed, setLookupFailed] = React.useState(false)
  const [open, setOpen] = React.useState(false)
  const [search, setSearch] = React.useState('')
  const loadStartedRef = React.useRef(false)

  const loadCatalog = React.useCallback(async () => {
    if (loadStartedRef.current) return
    loadStartedRef.current = true
    try {
      const call = await apiCall<{ items?: EndpointPickerItem[] }>(
        '/api/workflows/endpoints',
        undefined,
        { fallback: { items: [] } },
      )
      if (!call.ok || !Array.isArray(call.result?.items)) {
        setLookupFailed(true)
        setItems([])
        return
      }
      setLookupFailed(false)
      setItems(call.result.items)
    } catch {
      setLookupFailed(true)
      setItems([])
    }
  }, [])

  React.useEffect(() => {
    if (endpoint.trim().length > 0) void loadCatalog()
  }, [endpoint, loadCatalog])

  const effectiveMethod = method.trim().length > 0 ? method : 'GET'
  const selected = React.useMemo(
    () => items?.length ? findMatchingEndpoint(endpoint, effectiveMethod, items) : null,
    [endpoint, effectiveMethod, items],
  )
  const queryValues = React.useMemo(() => splitEndpointValue(endpoint).query, [endpoint])
  const headerValues = React.useMemo(() => endpointPickerStringRecord(headers), [headers])
  const paramRows = selected ? orderEndpointPickerParams(selected.item.params) : []
  const visibleItems = React.useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return items ?? []
    return (items ?? []).filter((item) =>
      [item.path, item.summary, item.tag, item.method].some((field) => field.toLowerCase().includes(query)),
    )
  }, [items, search])

  const handlePick = (item: EndpointPickerItem) => {
    const requiredPath = Object.fromEntries(
      item.params
        .filter((param) => param.in === 'path' && param.required)
        .map((param) => [param.name, requiredEndpointParamPlaceholder(param.name)]),
    )
    const requiredQuery = Object.fromEntries(
      item.params
        .filter((param) => param.in === 'query' && param.required)
        .map((param) => [param.name, requiredEndpointParamPlaceholder(param.name)]),
    )
    const requiredHeaders = Object.fromEntries(
      item.params
        .filter((param) => param.in === 'header' && param.required)
        .map((param) => [param.name, requiredEndpointParamPlaceholder(param.name)]),
    )
    const optionalPathParams = item.params
      .filter((param) => param.in === 'path' && !param.required)
      .map((param) => param.name)
    const retainedHeaders = Object.fromEntries(
      Object.entries(headerValues).filter(([, value]) => unresolvedRequiredEndpointParamName(value) === null),
    )
    onApply({
      endpoint: composeEndpointValue(item.path, requiredPath, requiredQuery, optionalPathParams),
      method: item.method,
      headers: { ...retainedHeaders, ...requiredHeaders },
    })
    setOpen(false)
    setSearch('')
  }

  const setParamValue = (param: EndpointPickerParam, nextValue: string) => {
    if (!selected) return
    if (param.in === 'header') {
      const nextHeaders = { ...headerValues }
      if (nextValue) nextHeaders[param.name] = nextValue
      else if (param.required) nextHeaders[param.name] = requiredEndpointParamPlaceholder(param.name)
      else delete nextHeaders[param.name]
      onApply({ headers: nextHeaders })
      return
    }

    const pathParams = { ...selected.match.pathParams }
    const nextQuery = { ...queryValues }
    if (param.in === 'path') {
      pathParams[param.name] = nextValue || (
        param.required ? requiredEndpointParamPlaceholder(param.name) : ''
      )
    } else if (nextValue) nextQuery[param.name] = nextValue
    else if (param.required) nextQuery[param.name] = requiredEndpointParamPlaceholder(param.name)
    else delete nextQuery[param.name]
    const optionalPathParams = selected.item.params
      .filter((candidate) => candidate.in === 'path' && !candidate.required)
      .map((candidate) => candidate.name)
    onApply({
      endpoint: composeEndpointValue(selected.item.path, pathParams, nextQuery, optionalPathParams),
    })
  }

  const paramValue = (param: EndpointPickerParam): string => {
    if (!selected) return ''
    if (param.in === 'path') {
      const value = selected.match.pathParams[param.name] ?? ''
      return unresolvedRequiredEndpointParamName(value) === null ? value : ''
    }
    if (param.in === 'query') {
      const value = queryValues[param.name] ?? ''
      return unresolvedRequiredEndpointParamName(value) === null ? value : ''
    }
    const value = headerValues[param.name] ?? ''
    return unresolvedRequiredEndpointParamName(value) === null ? value : ''
  }

  const requestHints = schemaFieldHints(selected?.item.requestSchema)
  const responseHints = schemaFieldHints(selected?.item.responseSchema)
  const groups = groupEndpointPickerItems(visibleItems)

  return (
    <div className="space-y-3">
      <div className="flex items-end gap-2">
        <div className="flex-1 space-y-1">
          <Label htmlFor={id}>{t('workflows.endpointPicker.endpoint')}</Label>
          <Input
            id={id}
            value={endpoint}
            onChange={(event) => onApply({ endpoint: event.target.value })}
            placeholder={t('workflows.endpointPicker.placeholder')}
            aria-invalid={endpoint.trim().length === 0}
            disabled={disabled}
          />
        </div>
        <Popover
          open={open}
          onOpenChange={(nextOpen) => {
            setOpen(nextOpen)
            if (nextOpen) void loadCatalog()
            else setSearch('')
          }}
        >
          <PopoverTrigger asChild>
            <Button type="button" variant="outline" size="sm" disabled={disabled}>
              <Globe className="mr-1 size-4" />
              {t('workflows.endpointPicker.browse')}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-80 p-0 sm:w-96" align="end">
            <div className="border-b border-border p-2">
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t('workflows.endpointPicker.searchPlaceholder')}
                aria-label={t('workflows.endpointPicker.searchPlaceholder')}
              />
            </div>
            <div className="max-h-80 overflow-y-auto p-1">
              {items === null ? (
                <p className="p-3 text-xs text-muted-foreground">{t('common.loading')}</p>
              ) : lookupFailed ? (
                <p className="p-3 text-xs text-muted-foreground">
                  {t('workflows.endpointPicker.lookupUnavailable')}
                </p>
              ) : groups.length === 0 ? (
                <p className="p-3 text-xs text-muted-foreground">{t('workflows.endpointPicker.noResults')}</p>
              ) : (
                groups.map((group) => (
                  <div key={group.tag || '__untagged'}>
                    <p className="px-2 pb-1 pt-2 text-xs font-semibold text-muted-foreground">
                      {group.tag || t('workflows.endpointPicker.untagged')}
                    </p>
                    {group.items.map((item) => (
                      <Button
                        key={`${item.method} ${item.path}`}
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => handlePick(item)}
                        className="h-auto w-full justify-start gap-2 px-2 py-2"
                      >
                        <Badge variant="secondary" className="shrink-0 text-xs">{item.method}</Badge>
                        <span className="min-w-0 truncate font-mono text-xs">{item.path}</span>
                        <span className="ml-auto min-w-0 truncate text-xs text-muted-foreground">{item.summary}</span>
                      </Button>
                    ))}
                  </div>
                ))
              )}
            </div>
          </PopoverContent>
        </Popover>
      </div>

      {lookupFailed && <p className="text-xs text-muted-foreground">{t('workflows.endpointPicker.lookupUnavailable')}</p>}
      {selected && <p className="text-xs text-muted-foreground">{selected.item.summary}</p>}
      {paramRows.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium">{t('workflows.endpointPicker.params')}</p>
          {paramRows.map((param) => {
            const fieldId = `${id}-${param.in}-${param.name}`
            const value = paramValue(param)
            const invalid = param.required && value.trim().length === 0
            return (
              <div key={`${param.in}-${param.name}`} className="grid gap-1 sm:grid-cols-2 sm:items-start">
                <Label htmlFor={fieldId} className="truncate pt-2 font-mono text-xs">
                  {param.name}{param.required ? ' *' : ''}
                </Label>
                <div className="flex items-center gap-2">
                  <Input
                    id={fieldId}
                    value={value}
                    onChange={(event) => setParamValue(param, event.target.value)}
                    inputMode={param.type === 'number' || param.type === 'integer' ? 'decimal' : undefined}
                    aria-invalid={invalid}
                    disabled={disabled}
                    className="flex-1"
                  />
                  <Badge variant="secondary" className="shrink-0 text-xs">{param.in} · {param.type}</Badge>
                </div>
                {invalid && (
                  <p role="alert" className="text-xs text-status-error-text sm:col-start-2">
                    {t('workflows.endpointPicker.requiredParameter')}
                  </p>
                )}
              </div>
            )
          })}
        </div>
      )}

      {selected && (
        <div className="grid gap-3 sm:grid-cols-2">
          <EndpointSchemaHints
            title={t('workflows.endpointPicker.requestSchema')}
            hints={requestHints}
            emptyText={t('workflows.endpointPicker.schemaUnavailable')}
          />
          <EndpointSchemaHints
            title={t('workflows.endpointPicker.responseSchema')}
            hints={responseHints}
            emptyText={t('workflows.endpointPicker.schemaUnavailable')}
          />
        </div>
      )}
    </div>
  )
}
