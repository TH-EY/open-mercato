import type { InjectionWidgetModule } from '@open-mercato/shared/modules/widgets/injection'
import RawIdentityWidget from './widget.client'

const widget: InjectionWidgetModule = {
  metadata: {
    id: 'finoo_identities.injection.raw-identity',
    title: 'finoo_identities.raw.title',
    priority: 10,
    features: ['finoo_identities.view'],
    requiredModules: ['customers'],
  },
  Widget: RawIdentityWidget,
}

export default widget
