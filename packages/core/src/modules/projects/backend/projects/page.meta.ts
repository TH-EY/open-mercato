import React from 'react'

const projectsIcon = React.createElement(
  'svg',
  {
    width: 16,
    height: 16,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  },
  React.createElement('path', { d: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z' }),
  React.createElement('path', { d: 'M8 13h3' }),
  React.createElement('path', { d: 'M14 13h2' }),
  React.createElement('path', { d: 'M8 16h6' }),
)

export const metadata = {
  requireAuth: true,
  requireFeatures: ['projects.view'],
  pageTitle: 'Projects',
  pageTitleKey: 'projects.nav.projects',
  pageGroup: 'Operations',
  pageGroupKey: 'projects.nav.group',
  pagePriority: 40,
  pageOrder: 420,
  icon: projectsIcon,
  breadcrumb: [{ label: 'Projects', labelKey: 'projects.nav.projects' }],
}
