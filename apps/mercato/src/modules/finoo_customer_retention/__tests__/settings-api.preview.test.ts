import type { EntityManager } from '@mikro-orm/postgresql'
import type { AwilixContainer } from 'awilix'
import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import {
  CustomerActivity,
  CustomerComment,
  CustomerEntity,
  CustomerInteraction,
} from '@open-mercato/core/modules/customers/data/entities'

const mockFindWithDecryption = jest.fn()
let mockRegistryAvailable = true
let mockEnabledModuleIds = ['finoo_affiliates', 'finoo_intermediaries']

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findWithDecryption: (...args: unknown[]) => mockFindWithDecryption(...args),
}))
jest.mock('@open-mercato/shared/security/enabledModulesRegistry', () => ({
  hasEnabledModulesRegistry: () => mockRegistryAvailable,
  getEnabledModuleIds: () => mockEnabledModuleIds,
}))

import { createFinooCustomerRetentionPreviewService } from '../services/previewService'

describe('Finoo customer retention preview facts', () => {
  beforeEach(() => {
    mockFindWithDecryption.mockReset()
    mockRegistryAvailable = true
    mockEnabledModuleIds = ['finoo_affiliates', 'finoo_intermediaries']
  })

  it('counts only eligible people using the same activity and partner rules as projection', async () => {
    const now = new Date('2026-08-24T12:00:00.000Z')
    const people = [
      { id: 'person-1', kind: 'person', createdAt: new Date('2026-06-01T00:00:00.000Z'), updatedAt: now },
      { id: 'person-2', kind: 'person', createdAt: new Date('2026-06-01T00:00:00.000Z'), updatedAt: now },
      { id: 'person-3', kind: 'person', createdAt: new Date('2026-06-01T00:00:00.000Z'), updatedAt: now },
    ]
    mockFindWithDecryption.mockImplementation(async (_em, entity) => {
      if (entity === CustomerEntity) return people
      if (entity === CustomerComment) return []
      if (entity === CustomerInteraction) {
        return [{
          entity: 'person-1',
          status: 'cancelled',
          createdAt: new Date('2026-08-20T00:00:00.000Z'),
          occurredAt: new Date('2026-08-20T00:00:00.000Z'),
        }]
      }
      if (entity === CustomerActivity) return []
      return []
    })
    const em = {
      getConnection: () => ({ execute: async () => [{ now }] }),
      find: async () => [{
        customerEntityId: 'person-3',
        retentionStatus: 'expired',
        eligibilityAnchorAt: new Date('2026-06-01T00:00:00.000Z'),
        lastQualifyingActivityAt: null,
        retentionExpiresAt: new Date('2026-07-01T00:00:00.000Z'),
        expiredAt: new Date('2026-07-01T00:00:00.000Z'),
      }],
    } as unknown as EntityManager
    const query = jest.fn(async () => ({
        items: [{ id: 'customer-user-2', person_entity_id: 'person-2' }],
        page: 1,
        pageSize: 100,
        total: 1,
      }))
    const queryEngine = {
      query,
    } as unknown as QueryEngine
    const partnerProvider = {
      findFacts: async () => ({
        activeCustomerUserIds: ['customer-user-2'],
        latestDeletedAtByCustomerUserId: new Map(),
      }),
    }
    const container = {
      hasRegistration: (name: string) => name.endsWith('RetentionEligibilityProvider'),
      resolve: () => partnerProvider,
    } as unknown as AwilixContainer
    const service = createFinooCustomerRetentionPreviewService({
      em,
      queryEngineFactory: () => queryEngine,
      container,
    })

    await expect(service.calculate({
      tenantId: 'tenant-1',
      organizationId: 'organization-1',
      inactivityWindowDays: 30,
      currentInactivityWindowDays: 30,
      now,
    })).resolves.toEqual({
      totalEligible: 2,
      newlyExpired: 0,
      alreadyExpired: 2,
    })
    expect(query).toHaveBeenCalledWith(
      'customer_accounts:customer_user',
      expect.objectContaining({ withDeleted: true }),
    )
  })

  it('evaluates live activity and restored eligibility instead of trusting stale persisted status', async () => {
    const now = new Date('2026-08-24T12:00:00.000Z')
    const recentlyActive = {
      id: 'person-active',
      kind: 'person',
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
      updatedAt: new Date('2026-08-23T00:00:00.000Z'),
    }
    const restored = {
      id: 'person-restored',
      kind: 'person',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: now,
    }
    mockFindWithDecryption.mockImplementation(async (_em, entity) => {
      if (entity === CustomerEntity) return [recentlyActive, restored]
      if (entity === CustomerComment) {
        return [{ entity: 'person-active', createdAt: new Date('2026-08-23T00:00:00.000Z') }]
      }
      return []
    })
    const oldExpiredState = {
      retentionStatus: 'expired',
      eligibilityAnchorAt: new Date('2026-01-01T00:00:00.000Z'),
      retentionExpiresAt: new Date('2026-02-01T00:00:00.000Z'),
      expiredAt: new Date('2026-02-01T00:00:00.000Z'),
      updatedAt: new Date('2026-08-20T00:00:00.000Z'),
    }
    const em = {
      find: jest.fn().mockResolvedValue([
        { ...oldExpiredState, customerEntityId: 'person-active', deletedAt: null },
        { ...oldExpiredState, customerEntityId: 'person-restored', deletedAt: new Date('2026-08-23T00:00:00.000Z') },
      ]),
    } as unknown as EntityManager
    const queryEngine = {
      query: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    } as unknown as QueryEngine
    const emptyProvider = {
      findFacts: jest.fn().mockResolvedValue({
        activeCustomerUserIds: [],
        latestDeletedAtByCustomerUserId: new Map(),
      }),
    }
    const container = {
      hasRegistration: () => true,
      resolve: () => emptyProvider,
    } as unknown as AwilixContainer
    const service = createFinooCustomerRetentionPreviewService({
      em,
      queryEngineFactory: () => queryEngine,
      container,
    })

    await expect(service.calculate({
      tenantId: 'tenant-1',
      organizationId: 'organization-1',
      inactivityWindowDays: 1,
      currentInactivityWindowDays: 30,
      now,
    })).resolves.toEqual({
      totalEligible: 2,
      newlyExpired: 1,
      alreadyExpired: 0,
    })
  })

  it('fails closed when the enabled-module registry is unavailable', async () => {
    mockRegistryAvailable = false
    const service = createFinooCustomerRetentionPreviewService({
      em: {} as EntityManager,
      queryEngineFactory: () => ({} as QueryEngine),
      container: {} as AwilixContainer,
    })

    await expect(service.calculate({
      tenantId: 'tenant-1',
      organizationId: 'organization-1',
      inactivityWindowDays: 30,
      currentInactivityWindowDays: null,
      now: new Date('2026-08-24T12:00:00.000Z'),
    })).rejects.toThrow('Enabled-module registry is unavailable')
  })

  it('fails closed when an enabled partner module has no provider', async () => {
    const service = createFinooCustomerRetentionPreviewService({
      em: {} as EntityManager,
      queryEngineFactory: () => ({} as QueryEngine),
      container: { hasRegistration: () => false } as unknown as AwilixContainer,
    })

    await expect(service.calculate({
      tenantId: 'tenant-1',
      organizationId: 'organization-1',
      inactivityWindowDays: 30,
      currentInactivityWindowDays: null,
      now: new Date('2026-08-24T12:00:00.000Z'),
    })).rejects.toThrow('missing its retention provider')
  })
})
