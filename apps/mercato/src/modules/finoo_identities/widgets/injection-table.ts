import type { ModuleInjectionTable } from '@open-mercato/shared/modules/widgets/injection'

export const injectionTable: ModuleInjectionTable = {
  'data-table:customers.people:columns': {
    widgetId: 'finoo_identities.injection.completeness-column',
    priority: 20,
  },
  'data-table:customers.people.list:columns': {
    widgetId: 'finoo_identities.injection.completeness-column',
    priority: 20,
  },
  'data-table:customers.people:filters': {
    widgetId: 'finoo_identities.injection.completeness-filter',
    priority: 20,
  },
  'data-table:customers.people.list:filters': {
    widgetId: 'finoo_identities.injection.completeness-filter',
    priority: 20,
  },
  'customers.person.detail:details': [
    {
      widgetId: 'finoo_identities.injection.completeness-detail',
      priority: 20,
    },
    {
      widgetId: 'finoo_identities.injection.raw-identity',
      priority: 10,
    },
  ],
  'detail:customers.person:footer': [
    {
      widgetId: 'finoo_identities.injection.completeness-detail',
      priority: 20,
    },
    {
      widgetId: 'finoo_identities.injection.raw-identity',
      priority: 10,
    },
  ],
}

export default injectionTable
