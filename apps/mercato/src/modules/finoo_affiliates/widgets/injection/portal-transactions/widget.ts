import type { InjectionWidgetModule } from '@open-mercato/shared/modules/widgets/injection'
import PortalTransactionsWidget from './widget.client'

const widget: InjectionWidgetModule = {
  metadata: {
    id: 'finoo_affiliates.portal.transactions',
    title: 'Transactions per week',
    features: ['portal.finoo_affiliates.view'],
    priority: 10,
  },
  Widget: PortalTransactionsWidget,
}

export default widget
