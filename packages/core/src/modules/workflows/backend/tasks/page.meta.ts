export const metadata = {
  requireAuth: true,
  requireFeatures: ['workflows.view_tasks'],
  pageTitle: 'User Tasks',
  pageTitleKey: 'workflows.tasks.title',
  pageGroup: 'Workflows',
  pageGroupKey: 'workflows.module.name',
  // The personal inbox is injected as a top-level "My tasks" destination.
  // Keep the legacy workflow-admin navigation entry out of end-user menus.
  navHidden: true,
  pagePriority: 30,
  pageOrder: 120,
  icon: 'check-square',
  breadcrumb: [
    { label: 'Workflows', labelKey: 'workflows.module.name' },
    { label: 'Tasks', labelKey: 'workflows.tasks.plural' },
  ],
}
