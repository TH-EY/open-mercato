import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'
import { seedEpcDemoExamples } from './seed'

export const setup: ModuleSetupConfig = {
  async seedExamples({ em, container, tenantId, organizationId }) {
    await seedEpcDemoExamples(em, container, { tenantId, organizationId })
  },
}

export default setup

