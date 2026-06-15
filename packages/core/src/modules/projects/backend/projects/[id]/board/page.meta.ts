export const metadata = {
  requireAuth: true,
  requireFeatures: ['projects.view'],
  pageTitle: 'Kanban board',
  pageTitleKey: 'projects.board.title',
  pageGroup: 'Operations',
  pageGroupKey: 'projects.nav.group',
  pagePriority: 40,
  pageOrder: 423,
  breadcrumb: [
    { label: 'Projects', labelKey: 'projects.nav.projects', href: '/backend/projects' },
    { label: 'Project', labelKey: 'projects.detail.title' },
    { label: 'Board', labelKey: 'projects.board.breadcrumb' },
  ],
}
