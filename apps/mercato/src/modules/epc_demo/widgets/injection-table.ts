import type { ModuleInjectionTable } from '@open-mercato/shared/modules/widgets/injection'

export const injectionTable: ModuleInjectionTable = {
  'portal:dashboard:sections': {
    widgetId: 'epc_demo.injection.survey-booking',
    priority: 5,
  },
}

export default injectionTable
