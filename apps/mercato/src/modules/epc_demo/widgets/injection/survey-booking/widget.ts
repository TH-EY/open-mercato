import type { InjectionWidgetModule } from '@open-mercato/shared/modules/widgets/injection'
import EpcSurveyBookingWidget, { type EpcSurveyBookingWidgetContext } from './widget.client'

const widget: InjectionWidgetModule<EpcSurveyBookingWidgetContext> = {
  metadata: {
    id: 'epc_demo.injection.survey-booking',
    title: 'Survey appointment',
    description: 'Customer portal survey appointment booking for EPC preview.',
    priority: 5,
    enabled: true,
  },
  Widget: EpcSurveyBookingWidget,
}

export default widget
