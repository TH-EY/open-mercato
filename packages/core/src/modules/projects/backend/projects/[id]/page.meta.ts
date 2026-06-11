export const metadata = {
  requireAuth: true,
  requireFeatures: ['projects.view'],
  pageTitle: 'Project',
  pageTitleKey: 'projects.detail.title',
  pageGroup: 'Operations',
  pageGroupKey: 'projects.nav.group',
  pagePriority: 40,
  pageOrder: 422,
  breadcrumb: [
    { label: 'Projects', labelKey: 'projects.nav.projects', href: '/backend/projects' },
    { label: 'Project', labelKey: 'projects.detail.title' },
  ],
}
