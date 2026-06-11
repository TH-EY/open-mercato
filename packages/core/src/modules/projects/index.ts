import type { ModuleInfo } from '@open-mercato/shared/modules/registry'
import './commands'

export const metadata: ModuleInfo = {
  name: 'projects',
  title: 'Projects',
  version: '0.1.0',
  description: 'Project tracking with tasks and Kanban boards.',
  author: 'Open Mercato Team',
  license: 'Proprietary',
  requires: ['auth', 'sales', 'attachments'],
  ejectable: true,
}

export { features } from './acl'
