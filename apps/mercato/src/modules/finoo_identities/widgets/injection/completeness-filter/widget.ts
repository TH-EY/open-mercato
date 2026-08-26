import type { InjectionWidgetModule } from '@open-mercato/shared/modules/widgets/injection'
import CompletenessFilterWidget, { type PeopleTableQueryFilterContext } from './widget.client'

const widget: InjectionWidgetModule<PeopleTableQueryFilterContext> = {
  metadata: {
    id: 'finoo_identities.injection.completeness-filter',
    title: 'finoo_identities.filter.label',
    priority: 20,
    requiredModules: ['customers'],
  },
  Widget: CompletenessFilterWidget,
}

export default widget
