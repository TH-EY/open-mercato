import type { InjectionWidgetModule } from '@open-mercato/shared/modules/widgets/injection'
import PortalAffiliateSummaryWidget from './widget.client'
const widget: InjectionWidgetModule = { metadata: { id: 'finoo_affiliates.portal.affiliate_summary', title: 'finooAffiliates.portal.dashboard.summary', features: ['portal.finoo_affiliates.view'], priority: 40 }, Widget: PortalAffiliateSummaryWidget }
export default widget
