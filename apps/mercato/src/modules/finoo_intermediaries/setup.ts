import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'

export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    superadmin: ['finoo_intermediaries.*'],
    admin: ['finoo_intermediaries.*'],
    employee: ['finoo_intermediaries.view'],
  },
  defaultCustomerRoleFeatures: {
    intermediary: ['portal.finoo_intermediaries.view'],
  },
}

export default setup
