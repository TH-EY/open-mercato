import type { InjectionFilterWidget } from '@open-mercato/shared/modules/widgets/injection'

const widget: InjectionFilterWidget = {
  metadata: {
    id: 'finoo_identities.injection.completeness-filter',
    priority: 20,
  },
  filters: [
    {
      id: 'finooIdentityComplete',
      label: 'finoo_identities.filter.label',
      type: 'select',
      strategy: 'server',
      queryParam: 'finooIdentityComplete',
      options: [
        { value: 'true', label: 'finoo_identities.aggregate.complete' },
        { value: 'false', label: 'finoo_identities.aggregate.incomplete' },
      ],
    },
  ],
}

export default widget
