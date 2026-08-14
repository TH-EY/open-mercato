import type { InjectionWidgetModule } from '@open-mercato/shared/modules/widgets/injection'
import PortalAffiliateTransactionsWidget from './widget.client'

const widget: InjectionWidgetModule = {
  metadata: {
    id: 'finoo_affiliates.portal.affiliate_transactions',
    title: 'finooAffiliates.portal.dashboard.affiliateTransactions',
    features: ['portal.finoo_affiliates.view'],
    priority: 5,
  },
  Widget: PortalAffiliateTransactionsWidget,
}

export default widget
