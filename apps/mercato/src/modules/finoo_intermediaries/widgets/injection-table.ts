import type { ModuleInjectionTable } from '@open-mercato/shared/modules/widgets/injection'

export const injectionTable: ModuleInjectionTable = {
  'data-table:customers.deals.list:bulk-actions': [
    {
      widgetId: 'finoo_intermediaries.injection.deal-bulk-assignment',
      priority: 20,
    },
  ],
  'detail:customers.deal:tabs': [
    {
      widgetId: 'finoo_intermediaries.injection.deal-assignment',
      kind: 'tab',
      groupLabel: 'finoo_intermediaries.staff.tabLabel',
      priority: 20,
    },
  ],
}

export default injectionTable
