import type { InjectionMenuItemWidget } from '@open-mercato/shared/modules/widgets/injection'

const widget: InjectionMenuItemWidget = {
  metadata: {
    id: 'workflows.injection.my-tasks-menu',
    title: 'Workflow task navigation items',
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
    {
      id: 'workflows-user-tasks-admin',
      labelKey: 'workflows.tasks.title',
      label: 'User Tasks',
      icon: 'ClipboardCheck',
      href: '/backend/tasks',
      // The destination needs the page and API read grants, while manage keeps
      // dependency-complete operational roles out of workflow administration.
      features: ['workflows.manage', 'workflows.view_tasks', 'workflows.tasks.view'],
      groupId: 'workflows.module.name',
      groupLabelKey: 'workflows.module.name',
      groupLabel: 'Workflows',
    },
  ],
}

export default widget
