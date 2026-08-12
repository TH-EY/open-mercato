import type { InjectionWidgetModule } from '@open-mercato/shared/modules/widgets/injection'
import PortalLeadsWidget from './widget.client'

const widget: InjectionWidgetModule = {
  metadata: {
    id: 'finoo_affiliates.portal.leads',
    title: 'Leads per week',
    features: ['portal.finoo_affiliates.view'],
    priority: 30,
  },
  Widget: PortalLeadsWidget,
}

export default widget
