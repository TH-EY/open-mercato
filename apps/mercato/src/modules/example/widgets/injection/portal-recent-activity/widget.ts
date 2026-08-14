import type { InjectionWidgetModule } from '@open-mercato/shared/modules/widgets/injection'
import PortalRecentActivityWidget from './widget.client'

const widget: InjectionWidgetModule = {
  metadata: {
    id: 'example.injection.portal-recent-activity',
    title: 'Recent Activity',
    description: 'Shows recent account activity in the portal dashboard.',
    features: ['portal.orders.view'],
    priority: 10,
    enabled: true,
  },
  Widget: PortalRecentActivityWidget,
}

export default widget
