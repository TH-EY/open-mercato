import { createHash } from 'node:crypto'
import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'
import { FINOO_APPLICATION_RECONCILE_QUEUE } from './workers/reconcile'
import { FINOO_APPLICATION_PRUNE_QUEUE } from './workers/prune'
import { isFinooApplicationScope } from './lib/scope'

type SchedulerServiceLike = { register: (registration: Record<string, unknown>) => Promise<void> }

function stableScheduleUuid(key: string): string {
  const hex = createHash('sha256').update(key).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

export const setup: ModuleSetupConfig = {
  async seedDefaults({ container, tenantId, organizationId }) {
    if (!isFinooApplicationScope({ tenantId, organizationId })) return
    if (!container || typeof (container as { hasRegistration?: unknown }).hasRegistration !== 'function') return
    if (!(container as { hasRegistration: (name: string) => boolean }).hasRegistration('schedulerService')) return
    const scope = { tenantId, organizationId }
    await (container.resolve('schedulerService') as SchedulerServiceLike).register({
      id: stableScheduleUuid(`finoo_applications:reconcile:${tenantId}:${organizationId}`),
      name: 'FINOO application intake reconciliation',
      description: 'Re-enqueue pending and expired FINOO application intake records.',
      scopeType: 'organization', ...scope,
      scheduleType: 'interval', scheduleValue: '1m', timezone: 'UTC',
      targetType: 'queue', targetQueue: FINOO_APPLICATION_RECONCILE_QUEUE, targetPayload: scope,
      sourceType: 'module', sourceModule: 'finoo_applications', isEnabled: true,
    })
    await (container.resolve('schedulerService') as SchedulerServiceLike).register({
      id: stableScheduleUuid(`finoo_applications:prune:${tenantId}:${organizationId}`),
      name: 'FINOO application intake retention',
      description: 'Remove encrypted FINOO payloads after the configured retention period.',
      scopeType: 'organization', ...scope,
      scheduleType: 'interval', scheduleValue: '1h', timezone: 'UTC',
      targetType: 'queue', targetQueue: FINOO_APPLICATION_PRUNE_QUEUE, targetPayload: scope,
      sourceType: 'module', sourceModule: 'finoo_applications', isEnabled: true,
    })
  },
}

export default setup
