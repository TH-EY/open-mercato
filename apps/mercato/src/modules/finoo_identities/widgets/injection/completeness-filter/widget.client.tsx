'use client'

import type { InjectionWidgetComponentProps } from '@open-mercato/shared/modules/widgets/injection'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@open-mercato/ui/primitives/select'

export const FINOO_IDENTITY_COMPLETENESS_QUERY_PARAM = 'finooIdentityComplete'

export type PeopleTableQueryFilterContext = {
  queryFilters?: Record<string, string>
  onQueryFilterChange?: (key: string, value: string | null) => void
}

export default function CompletenessFilterWidget({
  context,
}: InjectionWidgetComponentProps<PeopleTableQueryFilterContext>) {
  const t = useT()
  if (typeof context?.onQueryFilterChange !== 'function') return null
  const label = t('finoo_identities.filter.label')
  const value = context.queryFilters?.[FINOO_IDENTITY_COMPLETENESS_QUERY_PARAM] ?? 'all'

  return (
    <Select
      value={value}
      onValueChange={(nextValue) => context.onQueryFilterChange?.(
        FINOO_IDENTITY_COMPLETENESS_QUERY_PARAM,
        nextValue === 'all' ? null : nextValue,
      )}
    >
      <SelectTrigger aria-label={label} title={label} className="w-48">
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">{t('finoo_identities.filter.all')}</SelectItem>
        <SelectItem value="true">{t('finoo_identities.aggregate.complete')}</SelectItem>
        <SelectItem value="false">{t('finoo_identities.aggregate.incomplete')}</SelectItem>
      </SelectContent>
    </Select>
  )
}
