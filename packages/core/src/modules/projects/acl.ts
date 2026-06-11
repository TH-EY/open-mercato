export const features = [
  { id: 'projects.view', title: 'View projects', module: 'projects' },
  {
    id: 'projects.manage',
    title: 'Manage projects',
    module: 'projects',
    dependsOn: ['projects.view'],
  },
  {
    id: 'projects.tasks.manage',
    title: 'Manage project tasks',
    module: 'projects',
    dependsOn: ['projects.view'],
  },
]

export default features
