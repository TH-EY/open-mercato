import type { InjectionWidgetModule } from '@open-mercato/shared/modules/widgets/injection'
import DealAttributionWidget from './widget.client'
import type { WidgetContext } from './widget.client'

const widget: InjectionWidgetModule<WidgetContext> = {
  metadata: {
    id: 'finoo_affiliates.deal.attribution',
    title: 'Affiliate commission',
    features: ['finoo_affiliates.manage'],
  },
  Widget: DealAttributionWidget,
}

export default widget
