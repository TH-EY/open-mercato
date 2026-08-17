import { createHash } from 'node:crypto'
import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'
import { FINOO_INTERMEDIARY_ACCEPTANCE_RECONCILIATION_QUEUE } from './lib/directoryAcceptanceReconciliation'

type SchedulerServiceLike = { register: (registration: Record<string, unknown>) => Promise<void> }

function stableScheduleUuid(stableKey: string): string {
  const hex = createHash('sha256').update(stableKey).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

async function ensureAcceptanceReconciliationSchedule(
  container: import('awilix').AwilixContainer,
  scope: { tenantId: string; organizationId: string },
): Promise<void> {
  const cradle = container as { hasRegistration?: (name: string) => boolean }
  if (typeof cradle.hasRegistration !== 'function' || !cradle.hasRegistration('schedulerService')) return
  const schedulerService = container.resolve('schedulerService') as SchedulerServiceLike
  await schedulerService.register({
    id: stableScheduleUuid(
      `finoo_intermediaries:acceptance-reconciliation:${scope.tenantId}:${scope.organizationId}`,
    ),
    name: 'Finoo intermediary invitation acceptance reconciliation',
    description: 'Activate directory rows whose accepted invitation event was not delivered.',
    scopeType: 'organization',
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    scheduleType: 'interval',
    scheduleValue: '1m',
    timezone: 'UTC',
    targetType: 'queue',
    targetQueue: FINOO_INTERMEDIARY_ACCEPTANCE_RECONCILIATION_QUEUE,
    targetPayload: scope,
    sourceType: 'module',
    sourceModule: 'finoo_intermediaries',
    isEnabled: true,
  })
}

export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    superadmin: ['finoo_intermediaries.*'],
    admin: ['finoo_intermediaries.*'],
    employee: ['finoo_intermediaries.view'],
  },
  defaultCustomerRoleFeatures: {
    intermediary: ['portal.finoo_intermediaries.view'],
  },
  async seedDefaults({ container, tenantId, organizationId }) {
    await ensureAcceptanceReconciliationSchedule(container, { tenantId, organizationId })
  },
}

export default setup
