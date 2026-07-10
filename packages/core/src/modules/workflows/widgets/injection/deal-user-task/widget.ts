import type { InjectionWidgetModule } from '@open-mercato/shared/modules/widgets/injection'
import DealUserTaskWidget from './widget.client'

const widget: InjectionWidgetModule<Record<string, unknown>, Record<string, unknown>> = {
  metadata: {
    id: 'workflows.injection.deal-user-task',
    title: 'Deal user task action',
    description: 'Shows the current user workflow task on the related sales deal',
    features: ['workflows.tasks.view'],
    priority: 80,
    enabled: true,
  },
  Widget: DealUserTaskWidget,
}

export default widget
