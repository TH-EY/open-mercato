import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'

export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    admin: ['projects.*'],
    employee: ['projects.view', 'projects.tasks.manage'],
  },
}

export default setup
