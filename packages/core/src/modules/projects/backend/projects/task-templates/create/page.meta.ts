export const metadata = {
  requireAuth: true,
  requireFeatures: ['projects.templates.manage'],
  pageTitle: 'Create task template',
  pageTitleKey: 'projects.templates.task.create.title',
  pageGroup: 'Operations',
  pageGroupKey: 'projects.nav.group',
  pagePriority: 40,
  pageOrder: 425,
  breadcrumb: [
    { label: 'Projects', labelKey: 'projects.nav.projects', href: '/backend/projects' },
    { label: 'Task templates', labelKey: 'projects.templates.task.list.title', href: '/backend/projects/task-templates' },
    { label: 'Create task template', labelKey: 'projects.templates.task.create.title' },
  ],
}
