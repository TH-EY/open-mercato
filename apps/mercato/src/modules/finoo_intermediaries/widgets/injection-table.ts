import type { ModuleInjectionTable } from '@open-mercato/shared/modules/widgets/injection'

export const injectionTable: ModuleInjectionTable = {
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
