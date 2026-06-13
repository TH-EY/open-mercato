export const metadata = {
  requireAuth: true,
  requireFeatures: ['projects.templates.manage'],
  pageTitle: 'Project template',
  pageTitleKey: 'projects.templates.project.detail.title',
  pageGroup: 'Operations',
  pageGroupKey: 'projects.nav.group',
  pagePriority: 40,
  pageOrder: 429,
  breadcrumb: [
    { label: 'Projects', labelKey: 'projects.nav.projects', href: '/backend/projects' },
    { label: 'Project templates', labelKey: 'projects.templates.project.list.title', href: '/backend/projects/templates' },
    { label: 'Project template', labelKey: 'projects.templates.project.detail.title' },
  ],
}
