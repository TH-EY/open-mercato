import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'
import { seedEpcDemoExamples } from './seed'
import { ensureEpcLeadCaptureMetadata } from './lib/leadCapture'

export const setup: ModuleSetupConfig = {
  async seedDefaults({ em, tenantId, organizationId }) {
    await ensureEpcLeadCaptureMetadata(em, { tenantId, organizationId })
  },

  async seedExamples({ em, container, tenantId, organizationId }) {
    await ensureEpcLeadCaptureMetadata(em, { tenantId, organizationId })
    await seedEpcDemoExamples(em, container, { tenantId, organizationId })
  },
}

export default setup
