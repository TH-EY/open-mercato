import { createHash } from 'node:crypto'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'
import { FinooCustomerRetentionSettings } from './data/entities'
import { FINOO_CUSTOMER_RETENTION_RECONCILE_QUEUE } from './lib/constants'

type SchedulerService = {
  register(registration: Record<string, unknown>): Promise<void>
}

type SetupContainer = {
  hasRegistration?(name: string): boolean
  resolve<T = unknown>(name: string): T
}

export function finooCustomerRetentionScheduleId(
  tenantId: string,
  organizationId: string,
): string {
  const hex = createHash('sha256')
    .update(`finoo_customer_retention:reconcile:${tenantId}:${organizationId}`)
    .digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

async function ensureSettings(
  em: EntityManager,
  scope: { tenantId: string; organizationId: string },
): Promise<void> {
  const existing = await em.findOne(FinooCustomerRetentionSettings, scope)
  if (existing) return
  em.persist(em.create(FinooCustomerRetentionSettings, {
    ...scope,
    inactivityWindowDays: null,
    previewTokenHash: null,
    previewWindowDays: null,
    previewTotalEligible: null,
    previewNewlyExpired: null,
    previewAlreadyExpired: null,
    previewExpiresAt: null,
    reconciliationGeneration: 0,
  }))
  await em.flush()
}

async function ensureSchedule(
  container: SetupContainer,
  scope: { tenantId: string; organizationId: string },
): Promise<void> {
  if (container.hasRegistration?.('schedulerService') === false) {
    throw new Error('[internal] Finoo customer retention requires schedulerService')
  }
  const scheduler = container.resolve<SchedulerService>('schedulerService')
  await scheduler.register({
    id: finooCustomerRetentionScheduleId(scope.tenantId, scope.organizationId),
    name: 'Finoo customer retention reconciliation',
    description: 'Reconcile Finoo customer retention projections and expire due people.',
    scopeType: 'organization',
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    scheduleType: 'interval',
    scheduleValue: '1h',
    timezone: 'UTC',
    targetType: 'queue',
    targetQueue: FINOO_CUSTOMER_RETENTION_RECONCILE_QUEUE,
    targetPayload: scope,
    sourceType: 'module',
    sourceModule: 'finoo_customer_retention',
    isEnabled: true,
  })
}

export async function ensureFinooCustomerRetentionOrganizationSetup(input: {
  em: EntityManager
  container: SetupContainer
  tenantId: string
  organizationId: string
}): Promise<void> {
  const scope = {
    tenantId: input.tenantId,
    organizationId: input.organizationId,
  }
  await ensureSettings(input.em, scope)
  await ensureSchedule(input.container, scope)
}

export const setup: ModuleSetupConfig = {
  async seedDefaults({ em, container, tenantId, organizationId }) {
    await ensureFinooCustomerRetentionOrganizationSetup({
      em,
      container,
      tenantId,
      organizationId,
    })
  },
}

export default setup
