import type { ModuleInjectionTable } from '@open-mercato/shared/modules/widgets/injection'

const injectionTable: ModuleInjectionTable = {
  'portal:dashboard:sections': [
    { widgetId: 'finoo_affiliates.portal.leads', priority: 30 },
    { widgetId: 'finoo_affiliates.portal.clicks', priority: 20 },
    { widgetId: 'finoo_affiliates.portal.transactions', priority: 10 },
  ],
  'detail:customers.deal:tabs': {
    widgetId: 'finoo_affiliates.deal.attribution',
    kind: 'tab',
    groupLabel: 'finooAffiliates.deal.tab',
    priority: 20,
  },
}

export default injectionTable
