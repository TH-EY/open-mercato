import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'
import { seedEpcDemoExamples } from './seed'
import { ensureEpcLeadCaptureMetadata } from './lib/leadCapture'
import { EPC_SURVEY_BOOKING_FEATURE } from './lib/surveyBookingTypes'

export const setup: ModuleSetupConfig = {
  defaultCustomerRoleFeatures: {
    buyer: [EPC_SURVEY_BOOKING_FEATURE],
    viewer: [EPC_SURVEY_BOOKING_FEATURE],
  },

  async seedDefaults({ em, tenantId, organizationId }) {
    await ensureEpcLeadCaptureMetadata(em, { tenantId, organizationId })
  },

  async seedExamples({ em, container, tenantId, organizationId }) {
    await ensureEpcLeadCaptureMetadata(em, { tenantId, organizationId })
    await seedEpcDemoExamples(em, container, { tenantId, organizationId })
  },
}

export default setup
