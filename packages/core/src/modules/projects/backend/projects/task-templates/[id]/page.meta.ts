export const metadata = {
  requireAuth: true,
  requireFeatures: ['projects.templates.manage'],
  pageTitle: 'Task template',
  pageTitleKey: 'projects.templates.task.detail.title',
  pageGroup: 'Operations',
  pageGroupKey: 'projects.nav.group',
  pagePriority: 40,
  pageOrder: 426,
  breadcrumb: [
    { label: 'Projects', labelKey: 'projects.nav.projects', href: '/backend/projects' },
    { label: 'Task templates', labelKey: 'projects.templates.task.list.title', href: '/backend/projects/task-templates' },
    { label: 'Task template', labelKey: 'projects.templates.task.detail.title' },
  ],
}
