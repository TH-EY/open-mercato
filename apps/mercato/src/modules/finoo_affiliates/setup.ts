import { createHash } from 'node:crypto'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createLogger } from '@open-mercato/shared/lib/logger'
import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { Dictionary, DictionaryEntry } from '@open-mercato/core/modules/dictionaries/data/entities'
import { FINOO_AFFILIATE_VISITOR_PRUNE_QUEUE } from './lib/visitRetention'
import { FINOO_ACCEPTANCE_RECONCILIATION_QUEUE } from './lib/acceptanceReconciliation'
import { FINOO_PAYOUT_PREVIEW_PRUNE_QUEUE } from './lib/payouts'

export const FINOO_COMMISSION_STATUS_DICTIONARY_KEY = 'finoo_commission_status'
export const FINOO_AFFILIATE_TRANSACTION_STATUS_DICTIONARY_KEY = 'finoo_affiliate_transaction_status'

const commissionStatuses = [
  { value: 'waiting', label: 'Waiting', position: 0, isDefault: true },
  { value: 'approved', label: 'Approved', position: 1, isDefault: false },
  { value: 'rejected', label: 'Rejected', position: 2, isDefault: false },
] as const

const affiliateTransactionStatuses = [
  { value: 'processing', label: 'Processing', position: 0, isDefault: true },
  { value: 'approved', label: 'Approved', position: 1, isDefault: false },
  { value: 'rejected', label: 'Rejected', position: 2, isDefault: false },
  { value: 'paid_out', label: 'Paid out', position: 3, isDefault: false },
] as const

type StatusDefinition = {
  value: string
  label: string
  position: number
  isDefault: boolean
}

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

async function ensureAcceptanceReconciliationSchedule(
  container: import('awilix').AwilixContainer | undefined,
  scope: { tenantId: string; organizationId: string },
): Promise<void> {
  if (!container) return
  const cradle = container as { hasRegistration?: (name: string) => boolean }
  if (typeof cradle.hasRegistration !== 'function' || !cradle.hasRegistration('schedulerService')) return
  try {
    const schedulerService = container.resolve('schedulerService') as SchedulerServiceLike
    await schedulerService.register({
      id: stableScheduleUuid(`finoo_affiliates:acceptance-reconciliation:${scope.tenantId}:${scope.organizationId}`),
      name: 'Finoo affiliate acceptance reconciliation',
      description: 'Create missing affiliate transactions from post-deploy Accepted registry rows.',
      scopeType: 'organization',
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      scheduleType: 'interval',
      scheduleValue: '5m',
      timezone: 'UTC',
      targetType: 'queue',
      targetQueue: FINOO_ACCEPTANCE_RECONCILIATION_QUEUE,
      targetPayload: scope,
      sourceType: 'module',
      sourceModule: 'finoo_affiliates',
      isEnabled: true,
    })
  } catch (error) {
    logger.warn('Failed to register affiliate acceptance reconciliation schedule', { err: error })
  }
}

async function ensurePayoutPreviewPruneSchedule(
  container: import('awilix').AwilixContainer | undefined,
  scope: { tenantId: string; organizationId: string },
): Promise<void> {
  if (!container) return
  const cradle = container as { hasRegistration?: (name: string) => boolean }
  if (typeof cradle.hasRegistration !== 'function' || !cradle.hasRegistration('schedulerService')) return
  try {
    const schedulerService = container.resolve('schedulerService') as SchedulerServiceLike
    await schedulerService.register({
      id: stableScheduleUuid(`finoo_affiliates:payout-preview-prune:${scope.tenantId}:${scope.organizationId}`),
      name: 'Finoo payout preview prune',
      description: 'Remove expired unused affiliate payout previews.',
      scopeType: 'organization', tenantId: scope.tenantId, organizationId: scope.organizationId,
      scheduleType: 'interval', scheduleValue: '1h', timezone: 'UTC', targetType: 'queue',
      targetQueue: FINOO_PAYOUT_PREVIEW_PRUNE_QUEUE, targetPayload: scope,
      sourceType: 'module', sourceModule: 'finoo_affiliates', isEnabled: true,
    })
  } catch (error) {
    logger.warn('Failed to register payout preview prune schedule', { err: error })
  }
}

async function ensureStatusDictionary(
  em: EntityManager,
  scope: { tenantId: string; organizationId: string },
  definition: {
    key: string
    name: string
    description: string
    statuses: readonly StatusDefinition[]
  },
): Promise<void> {
  let dictionary = await findOneWithDecryption(
    em,
    Dictionary,
    { ...scope, key: definition.key, deletedAt: null },
    undefined,
    scope,
  )

  if (!dictionary) {
    const now = new Date()
    dictionary = em.create(Dictionary, {
      ...scope,
      key: definition.key,
      name: definition.name,
      description: definition.description,
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

  for (const status of definition.statuses) {
    const existing = await findOneWithDecryption(
      em,
      DictionaryEntry,
      {
        dictionary: dictionary.id,
        ...scope,
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
      ...scope,
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
}

export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    superadmin: ['finoo_affiliates.*'],
    admin: ['finoo_affiliates.*'],
    employee: ['finoo_affiliates.view'],
  },
  defaultCustomerRoleFeatures: {
    affiliate: ['portal.finoo_affiliates.view', 'portal.finoo_affiliates.profile.manage'],
  },
  async seedDefaults({ em, container, tenantId, organizationId }) {
    const scope = { tenantId, organizationId }
    await ensureStatusDictionary(em, scope, {
      key: FINOO_COMMISSION_STATUS_DICTIONARY_KEY,
      name: 'Finoo commission status',
      description: 'Commission approval status for Finoo affiliate Deals.',
      statuses: commissionStatuses,
    })
    await ensureStatusDictionary(em, scope, {
      key: FINOO_AFFILIATE_TRANSACTION_STATUS_DICTIONARY_KEY,
      name: 'Finoo affiliate transaction status',
      description: 'Commission lifecycle status for Finoo affiliate transactions.',
      statuses: affiliateTransactionStatuses,
    })
    await ensureVisitorPruneSchedule(container, scope)
    await ensureAcceptanceReconciliationSchedule(container, scope)
    await ensurePayoutPreviewPruneSchedule(container, scope)
  },
}

export default setup
