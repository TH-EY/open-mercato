import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { IsolationLevel, LockMode } from '@mikro-orm/core'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { AwilixContainer } from 'awilix'
import { ProgressJob } from '@open-mercato/core/modules/progress/data/entities'
import { enforceCommandOptimisticLockWithGuards } from '@open-mercato/shared/lib/crud/optimistic-lock-command'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { FinooCustomerRetentionSettings } from '../data/entities'
import { getFinooCustomerRetentionReconciliationQueue } from '../lib/reconciliationQueue'
import type {
  FinooCustomerRetentionPreviewService,
  RetentionPreviewCounts,
  RetentionPreviewScope,
} from './previewService'

const PREVIEW_TTL_MS = 10 * 60 * 1000
const logger = createLogger('finoo_customer_retention').child({ component: 'settings-service' })

export class RetentionSettingsError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'RetentionSettingsError'
  }
}

export function isRetentionSettingsError(error: unknown): error is RetentionSettingsError {
  if (!error || typeof error !== 'object') return false
  const candidate = error as Partial<RetentionSettingsError>
  return candidate.name === 'RetentionSettingsError'
    && typeof candidate.message === 'string'
    && (
      (candidate.status === 500 && candidate.code === 'settings_missing')
      || (
        candidate.status === 409
        && (candidate.code === 'preview_required' || candidate.code === 'preview_stale')
      )
    )
}

export type RetentionSettingView = {
  inactivityWindowDays: number | null
  reconciliationGeneration: number
  updatedAt: string
}

export type RetentionPreviewView = RetentionPreviewCounts & {
  settingId: string
  token: string
  expiresAt: string
  updatedAt: string
}

function hashPreviewToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

function equalTokenHash(tokenOrHash: string, expectedHash: string, alreadyHashed = false): boolean {
  const actual = Buffer.from(alreadyHashed ? tokenOrHash : hashPreviewToken(tokenOrHash), 'hex')
  const expected = Buffer.from(expectedHash, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function requiresPreview(current: number | null, proposed: number | null): boolean {
  return proposed !== null && (current === null || proposed < current)
}

function sameCounts(
  left: RetentionPreviewCounts,
  right: RetentionPreviewCounts,
): boolean {
  return left.totalEligible === right.totalEligible
    && left.newlyExpired === right.newlyExpired
    && left.alreadyExpired === right.alreadyExpired
}

function toView(setting: FinooCustomerRetentionSettings): RetentionSettingView {
  return {
    inactivityWindowDays: setting.inactivityWindowDays ?? null,
    reconciliationGeneration: setting.reconciliationGeneration,
    updatedAt: setting.updatedAt.toISOString(),
  }
}

function clearPreview(setting: FinooCustomerRetentionSettings): void {
  setting.previewTokenHash = null
  setting.previewWindowDays = null
  setting.previewTotalEligible = null
  setting.previewNewlyExpired = null
  setting.previewAlreadyExpired = null
  setting.previewExpiresAt = null
}

async function loadSetting(
  em: EntityManager,
  scope: RetentionPreviewScope,
  lockMode?: LockMode,
): Promise<FinooCustomerRetentionSettings> {
  const setting = await em.findOne(
    FinooCustomerRetentionSettings,
    scope,
    lockMode ? { lockMode } : undefined,
  )
  if (!setting) {
    throw new RetentionSettingsError(500, 'settings_missing', 'Retention settings are not initialized')
  }
  return setting
}

export type FinooCustomerRetentionSettingsService = ReturnType<
  typeof createFinooCustomerRetentionSettingsService
>

export function createFinooCustomerRetentionSettingsService(input: {
  em: EntityManager
  previewService: FinooCustomerRetentionPreviewService
  container: AwilixContainer
}) {
  async function get(scope: RetentionPreviewScope): Promise<RetentionSettingView> {
    return toView(await loadSetting(input.em, scope))
  }

  async function preview(request: RetentionPreviewScope & {
    inactivityWindowDays: number
    httpRequest?: Request
  }): Promise<RetentionPreviewView> {
    const token = randomBytes(32).toString('base64url')
    return input.em.fork().transactional(async (em) => {
      const setting = await loadSetting(em, {
        tenantId: request.tenantId,
        organizationId: request.organizationId,
      }, LockMode.PESSIMISTIC_WRITE)
      await enforceCommandOptimisticLockWithGuards(input.container, {
        resourceKind: 'finoo_customer_retention.settings',
        resourceId: setting.id,
        current: setting.updatedAt,
        request: request.httpRequest,
      })
      const now = await input.previewService.databaseNow(em)
      const counts = await input.previewService.calculate({
        ...request,
        currentInactivityWindowDays: setting.inactivityWindowDays ?? null,
        em,
        now,
      })
      const expiresAt = new Date(now.getTime() + PREVIEW_TTL_MS)
      setting.previewTokenHash = hashPreviewToken(token)
      setting.previewWindowDays = request.inactivityWindowDays
      setting.previewTotalEligible = counts.totalEligible
      setting.previewNewlyExpired = counts.newlyExpired
      setting.previewAlreadyExpired = counts.alreadyExpired
      setting.previewExpiresAt = expiresAt
      await em.flush()
      return {
        settingId: setting.id,
        token,
        expiresAt: expiresAt.toISOString(),
        updatedAt: setting.updatedAt.toISOString(),
        ...counts,
      }
    }, { isolationLevel: IsolationLevel.REPEATABLE_READ })
  }

  async function update(request: RetentionPreviewScope & {
    inactivityWindowDays: number | null
    previewTokenHash?: string
    actorUserId: string | null
    httpRequest?: Request
  }): Promise<{ settingId: string; setting: RetentionSettingView; progressJobId: string }> {
    const transactionResult = await input.em.fork().transactional(async (em) => {
      const setting = await loadSetting(em, {
        tenantId: request.tenantId,
        organizationId: request.organizationId,
      }, LockMode.PESSIMISTIC_WRITE)
      await enforceCommandOptimisticLockWithGuards(input.container, {
        resourceKind: 'finoo_customer_retention.settings',
        resourceId: setting.id,
        current: setting.updatedAt,
        request: request.httpRequest,
      })
      const previewRequired = requiresPreview(
        setting.inactivityWindowDays ?? null,
        request.inactivityWindowDays,
      )
      let totalEligible: number | null = null
      if (previewRequired) {
        const now = await input.previewService.databaseNow(em)
        const previewTokenHash = request.previewTokenHash
        const storedCounts = {
          totalEligible: setting.previewTotalEligible ?? -1,
          newlyExpired: setting.previewNewlyExpired ?? -1,
          alreadyExpired: setting.previewAlreadyExpired ?? -1,
        }
        if (!previewTokenHash) {
          throw new RetentionSettingsError(409, 'preview_required', 'A fresh matching preview is required')
        }
        if (
          !setting.previewTokenHash
          || setting.previewWindowDays !== request.inactivityWindowDays
          || !setting.previewExpiresAt
          || setting.previewExpiresAt <= now
          || !equalTokenHash(previewTokenHash, setting.previewTokenHash, true)
        ) {
          throw new RetentionSettingsError(409, 'preview_stale', 'Retention preview is stale')
        }
        const freshCounts = await input.previewService.calculate({
          ...request,
          inactivityWindowDays: request.inactivityWindowDays!,
          currentInactivityWindowDays: setting.inactivityWindowDays ?? null,
          em,
          now,
        })
        if (!sameCounts(storedCounts, freshCounts)) {
          throw new RetentionSettingsError(409, 'preview_stale', 'Retention preview counts changed')
        }
        totalEligible = freshCounts.totalEligible
      }

      setting.inactivityWindowDays = request.inactivityWindowDays
      setting.reconciliationGeneration += 1
      clearPreview(setting)
      const progressJob = em.create(ProgressJob, {
        jobType: 'finoo_customer_retention.reconcile',
        name: 'Finoo customer retention reconciliation',
        description: null,
        status: 'pending',
        progressPercent: 0,
        processedCount: 0,
        totalCount: totalEligible,
        cancellable: false,
        startedByUserId: request.actorUserId,
        tenantId: request.tenantId,
        organizationId: request.organizationId,
        meta: {
          reconciliationGeneration: setting.reconciliationGeneration,
          nextAfterCustomerEntityId: null,
          checkpointComplete: false,
        },
      })
      em.persist(progressJob)
      await em.flush()
      return {
        settingId: setting.id,
        setting: toView(setting),
        progressJobId: progressJob.id,
        reconciliationGeneration: setting.reconciliationGeneration,
      }
    }, { isolationLevel: IsolationLevel.REPEATABLE_READ })

    try {
      await getFinooCustomerRetentionReconciliationQueue().enqueue({
        tenantId: request.tenantId,
        organizationId: request.organizationId,
        reconciliationGeneration: transactionResult.reconciliationGeneration,
        progressJobId: transactionResult.progressJobId,
        actorUserId: request.actorUserId,
      })
    } catch (error) {
      logger.warn('Reconciliation enqueue failed; pending progress job retained for recovery', {
        err: error,
        progressJobId: transactionResult.progressJobId,
      })
    }
    return {
      settingId: transactionResult.settingId,
      setting: transactionResult.setting,
      progressJobId: transactionResult.progressJobId,
    }
  }

  async function clearPreviewIfCurrent(request: RetentionPreviewScope & {
    previewTokenHash: string
    updatedAt: string
  }): Promise<boolean> {
    return input.em.fork().transactional(async (em) => {
      const setting = await loadSetting(em, request, LockMode.PESSIMISTIC_WRITE)
      if (
        setting.previewTokenHash !== request.previewTokenHash
        || setting.updatedAt.toISOString() !== request.updatedAt
      ) return false
      clearPreview(setting)
      await em.flush()
      return true
    })
  }

  return { get, preview, update, clearPreviewIfCurrent }
}

export const retentionSettingsInternals = {
  hashPreviewToken,
  requiresPreview,
  PREVIEW_TTL_MS,
}
