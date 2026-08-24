import type { EntityManager } from '@mikro-orm/postgresql'
import { IsolationLevel } from '@mikro-orm/core'
import type { AwilixContainer } from 'awilix'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { FinooCustomerRetentionSettings } from '../data/entities'
import type { FinooCustomerRetentionPreviewService } from '../services/previewService'

const mockEvents: string[] = []
const mockEnqueue = jest.fn(async () => {
  mockEvents.push('enqueue')
})

jest.mock('../lib/reconciliationQueue', () => ({
  getFinooCustomerRetentionReconciliationQueue: () => ({ enqueue: mockEnqueue }),
}))

import {
  createFinooCustomerRetentionSettingsService,
  isRetentionSettingsError,
  RetentionSettingsError,
  retentionSettingsInternals,
} from '../services/settingsService'

const scope = {
  tenantId: '10000000-0000-4000-8000-000000000001',
  organizationId: '20000000-0000-4000-8000-000000000002',
}

function makeSetting(windowDays: number | null = null): FinooCustomerRetentionSettings {
  return Object.assign(new FinooCustomerRetentionSettings(), {
    id: '30000000-0000-4000-8000-000000000003',
    ...scope,
    inactivityWindowDays: windowDays,
    previewTokenHash: null,
    previewWindowDays: null,
    previewTotalEligible: null,
    previewNewlyExpired: null,
    previewAlreadyExpired: null,
    previewExpiresAt: null,
    reconciliationGeneration: 2,
    createdAt: new Date('2026-08-24T10:00:00.000Z'),
    updatedAt: new Date('2026-08-24T10:00:00.000Z'),
  })
}

function makeHarness(setting: FinooCustomerRetentionSettings, input?: {
  now?: Date
  counts?: { totalEligible: number; newlyExpired: number; alreadyExpired: number }
}) {
  const now = input?.now ?? new Date('2026-08-24T10:00:00.000Z')
  const counts = input?.counts ?? { totalEligible: 12, newlyExpired: 4, alreadyExpired: 2 }
  const findOne = jest.fn(async (_entity, filter) => {
    expect(filter).toEqual(scope)
    return setting
  })
  const flush = jest.fn(async () => {
    setting.updatedAt = new Date(setting.updatedAt.getTime() + 1000)
  })
  const transactionEm = {
    findOne,
    flush,
    create: jest.fn((_entity, data: Record<string, unknown>) => ({
      id: '40000000-0000-4000-8000-000000000004',
      ...data,
    })),
    persist: jest.fn(),
  }
  const rootEm = {
    findOne,
    fork: () => ({
      transactional: async (
        operation: (em: EntityManager) => Promise<unknown>,
        options?: { isolationLevel?: IsolationLevel },
      ) => {
        expect(options?.isolationLevel).toBe(IsolationLevel.REPEATABLE_READ)
        mockEvents.push('transaction')
        const result = await operation(transactionEm as unknown as EntityManager)
        mockEvents.push('commit')
        return result
      },
    }),
  } as unknown as EntityManager
  const previewService = {
    databaseNow: jest.fn(async () => now),
    calculate: jest.fn(async () => counts),
  } as unknown as FinooCustomerRetentionPreviewService
  const container = {
    resolve: jest.fn(() => {
      throw new Error('unregistered')
    }),
  } as unknown as AwilixContainer
  return {
    service: createFinooCustomerRetentionSettingsService({ em: rootEm, previewService, container }),
    previewService,
    findOne,
  }
}

describe('Finoo customer retention settings service', () => {
  beforeEach(() => {
    mockEvents.length = 0
    mockEnqueue.mockClear()
  })

  it('stores only a SHA-256 preview token hash and gives it a ten-minute TTL', async () => {
    const setting = makeSetting()
    const { service } = makeHarness(setting)
    const preview = await service.preview({ ...scope, inactivityWindowDays: 30 })

    expect(preview.token).toBeTruthy()
    expect(setting.previewTokenHash).toBe(retentionSettingsInternals.hashPreviewToken(preview.token))
    expect(setting.previewTokenHash).not.toContain(preview.token)
    expect(preview.expiresAt).toBe('2026-08-24T10:10:00.000Z')
    expect(preview.updatedAt).toBe('2026-08-24T10:00:01.000Z')
  })

  it('requires previews only for first enable and period reductions', () => {
    expect(retentionSettingsInternals.requiresPreview(null, 30)).toBe(true)
    expect(retentionSettingsInternals.requiresPreview(60, 30)).toBe(true)
    expect(retentionSettingsInternals.requiresPreview(30, 60)).toBe(false)
    expect(retentionSettingsInternals.requiresPreview(30, null)).toBe(false)
  })

  it('recognizes the constrained error contract across generated bundle boundaries', () => {
    expect(isRetentionSettingsError({
      name: 'RetentionSettingsError',
      message: 'Retention preview counts changed',
      status: 409,
      code: 'preview_stale',
    })).toBe(true)
    expect(isRetentionSettingsError({
      name: 'RetentionSettingsError',
      message: 'Unexpected status',
      status: 200,
      code: 'preview_stale',
    })).toBe(false)
  })

  it('rejects an expired preview without changing the setting', async () => {
    const setting = makeSetting()
    const first = makeHarness(setting)
    const preview = await first.service.preview({ ...scope, inactivityWindowDays: 30 })
    setting.previewExpiresAt = new Date('2026-08-24T09:59:59.000Z')

    await expect(first.service.update({
      ...scope,
      inactivityWindowDays: 30,
      previewTokenHash: retentionSettingsInternals.hashPreviewToken(preview.token),
      actorUserId: null,
    })).rejects.toMatchObject<Partial<RetentionSettingsError>>({
      status: 409,
      code: 'preview_stale',
    })
    expect(setting.inactivityWindowDays).toBeNull()
  })

  it('rejects confirmation when freshly recomputed counts differ', async () => {
    const setting = makeSetting()
    const first = makeHarness(setting)
    const preview = await first.service.preview({ ...scope, inactivityWindowDays: 30 })
    const second = makeHarness(setting, {
      counts: { totalEligible: 13, newlyExpired: 5, alreadyExpired: 2 },
    })

    await expect(second.service.update({
      ...scope,
      inactivityWindowDays: 30,
      previewTokenHash: retentionSettingsInternals.hashPreviewToken(preview.token),
      actorUserId: null,
    })).rejects.toMatchObject<Partial<RetentionSettingsError>>({
      status: 409,
      code: 'preview_stale',
    })
  })

  it('rejects a token that does not match the stored hash', async () => {
    const setting = makeSetting()
    const { service } = makeHarness(setting)
    await service.preview({ ...scope, inactivityWindowDays: 30 })

    await expect(service.update({
      ...scope,
      inactivityWindowDays: 30,
      previewTokenHash: retentionSettingsInternals.hashPreviewToken('different-token'),
      actorUserId: null,
    })).rejects.toMatchObject<Partial<RetentionSettingsError>>({
      status: 409,
      code: 'preview_stale',
    })
  })

  it('enforces optimistic locking inside scope and enqueues only after commit', async () => {
    const setting = makeSetting(30)
    const { service, findOne } = makeHarness(setting)
    const staleRequest = new Request('http://localhost/api/finoo_customer_retention/settings', {
      headers: {
        'x-om-ext-optimistic-lock-expected-updated-at': '2026-08-24T09:00:00.000Z',
      },
    })
    await expect(service.update({
      ...scope,
      inactivityWindowDays: 60,
      actorUserId: null,
      httpRequest: staleRequest,
    })).rejects.toBeInstanceOf(CrudHttpError)
    expect(findOne).toHaveBeenCalledWith(
      FinooCustomerRetentionSettings,
      scope,
      expect.objectContaining({ lockMode: expect.anything() }),
    )
    expect(mockEnqueue).not.toHaveBeenCalled()

    mockEvents.length = 0
    const currentRequest = new Request('http://localhost/api/finoo_customer_retention/settings', {
      headers: {
        'x-om-ext-optimistic-lock-expected-updated-at': setting.updatedAt.toISOString(),
      },
    })
    await service.update({
      ...scope,
      inactivityWindowDays: 60,
      actorUserId: '50000000-0000-4000-8000-000000000005',
      httpRequest: currentRequest,
    })
    expect(mockEvents).toEqual(['transaction', 'commit', 'enqueue'])
  })
})
