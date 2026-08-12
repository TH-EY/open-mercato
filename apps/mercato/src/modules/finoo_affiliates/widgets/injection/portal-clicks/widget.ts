import type { InjectionWidgetModule } from '@open-mercato/shared/modules/widgets/injection'
import PortalClicksWidget from './widget.client'

const widget: InjectionWidgetModule = {
  metadata: {
    id: 'finoo_affiliates.portal.clicks',
    title: 'finooAffiliates.portal.dashboard.clicks',
    features: ['portal.finoo_affiliates.view'],
    priority: 20,
  },
  Widget: PortalClicksWidget,
}

export default widget
