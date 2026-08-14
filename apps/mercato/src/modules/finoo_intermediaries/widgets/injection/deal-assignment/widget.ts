import type { InjectionWidgetModule } from '@open-mercato/shared/modules/widgets/injection'
import DealAssignmentWidget from './widget.client'

const widget: InjectionWidgetModule<{ dealId?: string }> = {
  metadata: {
    id: 'finoo_intermediaries.injection.deal-assignment',
    title: 'FINOO intermediary assignment',
    description: 'Manages the private intermediary assignment and shows partner notes.',
    features: ['finoo_intermediaries.view'],
  },
  Widget: DealAssignmentWidget,
}

export default widget
