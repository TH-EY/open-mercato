import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'
import { ensureRoles } from '@open-mercato/core/modules/auth/lib/setup-app'

export const FINOO_IOD_ROLE = 'IOD — Inspektor ochrony danych'

export const setup: ModuleSetupConfig = {
  async seedDefaults({ em, tenantId }) {
    await ensureRoles(em, { tenantId, roleNames: [FINOO_IOD_ROLE] })
  },
  defaultRoleFeatures: {
    superadmin: ['finoo_identities.*'],
    [FINOO_IOD_ROLE]: [
      'customers.people.view',
      'finoo_identities.view',
      'finoo_identities.manage',
    ],
  },
}

export default setup
