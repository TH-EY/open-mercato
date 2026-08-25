import type { InjectionWidgetModule } from '@open-mercato/shared/modules/widgets/injection'
import CompletenessFilterWidget, { type PeopleTableQueryFilterContext } from './widget.client'

const widget: InjectionWidgetModule<PeopleTableQueryFilterContext> = {
  metadata: {
    id: 'finoo_identities.injection.completeness-filter',
    priority: 20,
    requiredModules: ['customers'],
  },
  Widget: CompletenessFilterWidget,
}

export default widget
