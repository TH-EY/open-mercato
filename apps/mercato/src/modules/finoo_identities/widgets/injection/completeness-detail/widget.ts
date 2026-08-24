import type { InjectionWidgetModule } from '@open-mercato/shared/modules/widgets/injection'
import CompletenessDetailWidget from './widget.client'

const widget: InjectionWidgetModule = {
  metadata: {
    id: 'finoo_identities.injection.completeness-detail',
    title: 'finoo_identities.identity.title',
    priority: 20,
    requiredModules: ['customers'],
  },
  Widget: CompletenessDetailWidget,
}

export default widget
