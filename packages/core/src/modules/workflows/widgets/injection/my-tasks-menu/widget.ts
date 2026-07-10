import type { InjectionMenuItemWidget } from '@open-mercato/shared/modules/widgets/injection'

const widget: InjectionMenuItemWidget = {
  metadata: {
    id: 'workflows.injection.my-tasks-menu',
    title: 'My workflow tasks navigation item',
    features: ['workflows.tasks.view'],
  },
  menuItems: [
    {
      id: 'workflows-my-tasks',
      labelKey: 'workflows.tasks.myTasksNav',
      label: 'My tasks',
      icon: 'ClipboardCheck',
      href: '/backend/tasks',
      features: ['workflows.tasks.view'],
    },
  ],
}

export default widget
