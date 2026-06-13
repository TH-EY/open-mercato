export const metadata = {
  requireAuth: true,
  requireFeatures: ['projects.templates.manage'],
  pageTitle: 'Create project template',
  pageTitleKey: 'projects.templates.project.create.title',
  pageGroup: 'Operations',
  pageGroupKey: 'projects.nav.group',
  pagePriority: 40,
  pageOrder: 428,
  breadcrumb: [
    { label: 'Projects', labelKey: 'projects.nav.projects', href: '/backend/projects' },
    { label: 'Project templates', labelKey: 'projects.templates.project.list.title', href: '/backend/projects/templates' },
    { label: 'Create project template', labelKey: 'projects.templates.project.create.title' },
  ],
}
