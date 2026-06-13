export const metadata = {
  requireAuth: true,
  requireFeatures: ['projects.templates.manage'],
  pageTitle: 'Task templates',
  pageTitleKey: 'projects.templates.task.list.title',
  pageGroup: 'Operations',
  pageGroupKey: 'projects.nav.group',
  pagePriority: 40,
  pageOrder: 424,
  breadcrumb: [
    { label: 'Projects', labelKey: 'projects.nav.projects', href: '/backend/projects' },
    { label: 'Task templates', labelKey: 'projects.templates.task.list.title' },
  ],
}
