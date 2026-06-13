export const metadata = {
  requireAuth: true,
  requireFeatures: ['projects.templates.manage'],
  pageTitle: 'Project templates',
  pageTitleKey: 'projects.templates.project.list.title',
  pageGroup: 'Operations',
  pageGroupKey: 'projects.nav.group',
  pagePriority: 40,
  pageOrder: 427,
  breadcrumb: [
    { label: 'Projects', labelKey: 'projects.nav.projects', href: '/backend/projects' },
    { label: 'Project templates', labelKey: 'projects.templates.project.list.title' },
  ],
}
