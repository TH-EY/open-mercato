export const metadata = {
  requireAuth: true,
  requireFeatures: ['projects.manage'],
  pageTitle: 'Create project',
  pageTitleKey: 'projects.create.title',
  pageGroup: 'Operations',
  pageGroupKey: 'projects.nav.group',
  pagePriority: 40,
  pageOrder: 421,
  breadcrumb: [
    { label: 'Projects', labelKey: 'projects.nav.projects', href: '/backend/projects' },
    { label: 'Create project', labelKey: 'projects.create.title' },
  ],
}
