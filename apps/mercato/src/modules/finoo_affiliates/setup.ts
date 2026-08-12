import { createHash } from 'node:crypto'
import { createLogger } from '@open-mercato/shared/lib/logger'
import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { Dictionary, DictionaryEntry } from '@open-mercato/core/modules/dictionaries/data/entities'
import { FINOO_AFFILIATE_VISITOR_PRUNE_QUEUE } from './lib/visitRetention'

export const FINOO_COMMISSION_STATUS_DICTIONARY_KEY = 'finoo_commission_status'

const commissionStatuses = [
  { value: 'waiting', label: 'Waiting', position: 0, isDefault: true },
  { value: 'approved', label: 'Approved', position: 1, isDefault: false },
  { value: 'rejected', label: 'Rejected', position: 2, isDefault: false },
] as const

type SchedulerServiceLike = { register: (registration: Record<string, unknown>) => Promise<void> }

const logger = createLogger('finoo_affiliates')

function stableScheduleUuid(stableKey: string): string {
  const hex = createHash('sha256').update(stableKey).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

async function ensureVisitorPruneSchedule(
  container: import('awilix').AwilixContainer | undefined,
  scope: { tenantId: string; organizationId: string },
): Promise<void> {
  if (!container) return
  const cradle = container as { hasRegistration?: (name: string) => boolean }
  if (typeof cradle.hasRegistration !== 'function' || !cradle.hasRegistration('schedulerService')) return
  try {
    const schedulerService = container.resolve('schedulerService') as SchedulerServiceLike
    await schedulerService.register({
      id: stableScheduleUuid(`finoo_affiliates:visitor-prune:${scope.tenantId}:${scope.organizationId}`),
      name: 'Finoo affiliate visitor prune',
      description: 'Remove affiliate visitor hashes after the 24-hour uniqueness window.',
      scopeType: 'organization',
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      scheduleType: 'interval',
      scheduleValue: '1h',
      timezone: 'UTC',
      targetType: 'queue',
      targetQueue: FINOO_AFFILIATE_VISITOR_PRUNE_QUEUE,
      targetPayload: scope,
      sourceType: 'module',
      sourceModule: 'finoo_affiliates',
      isEnabled: true,
    })
  } catch (error) {
    logger.warn('Failed to register affiliate visitor prune schedule', { err: error })
  }
}

export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    superadmin: ['finoo_affiliates.*'],
    admin: ['finoo_affiliates.*'],
    employee: ['finoo_affiliates.view'],
  },
  defaultCustomerRoleFeatures: {
    affiliate: ['portal.finoo_affiliates.view'],
  },
  async seedDefaults({ em, container, tenantId, organizationId }) {
    const scope = { tenantId, organizationId }
    let dictionary = await findOneWithDecryption(
      em,
      Dictionary,
      { tenantId, organizationId, key: FINOO_COMMISSION_STATUS_DICTIONARY_KEY, deletedAt: null },
      undefined,
      scope,
    )

    if (!dictionary) {
      const now = new Date()
      dictionary = em.create(Dictionary, {
        tenantId,
        organizationId,
        key: FINOO_COMMISSION_STATUS_DICTIONARY_KEY,
        name: 'Finoo commission status',
        description: 'Commission approval status for Finoo affiliate Deals.',
        isSystem: true,
        isActive: true,
        managerVisibility: 'hidden',
        entrySortMode: 'label_asc',
        createdAt: now,
        updatedAt: now,
      })
      em.persist(dictionary)
      await em.flush()
    }

    for (const status of commissionStatuses) {
      const existing = await findOneWithDecryption(
        em,
        DictionaryEntry,
        {
          dictionary: dictionary.id,
          tenantId,
          organizationId,
          normalizedValue: status.value,
        },
        undefined,
        scope,
      )
      if (existing) {
        existing.value = status.value
        existing.label = status.label
        existing.position = status.position
        existing.isDefault = status.isDefault
        continue
      }
      em.persist(em.create(DictionaryEntry, {
        dictionary,
        tenantId,
        organizationId,
        value: status.value,
        normalizedValue: status.value,
        label: status.label,
        position: status.position,
        isDefault: status.isDefault,
        createdAt: new Date(),
        updatedAt: new Date(),
      }))
    }
    await em.flush()
    await ensureVisitorPruneSchedule(container, scope)
  },
}

export default setup
