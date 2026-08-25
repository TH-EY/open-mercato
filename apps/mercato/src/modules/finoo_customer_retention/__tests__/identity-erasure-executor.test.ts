import { FinooCustomerRetentionState } from '../data/entities'
import { createFinooIdentityErasureExecutor } from '../services/identityErasureExecutor'

const tenantId = '11111111-1111-4111-8111-111111111111'
const organizationId = '22222222-2222-4222-8222-222222222222'
const now = new Date('2026-08-25T12:00:00.000Z')

function createHarness(candidates: Array<{ id: string; customerEntityId: string }> = []) {
  const anonymizeAndDeleteForPerson = jest.fn(async () => ({ identitiesDeleted: 0,
  }))
  const transactionalEm = { marker: 'outer-transactional-em' }
  const runIdentityErasureIfAuthoritativelyDue = jest.fn(async (
    _request: unknown,
    operation: (context: {
        transactionalEm: unknown
        registerPostCommitEffect: (effect: () => Promise<void>,
  ) => void
      }) => Promise<void>,
    ) => {
      const effects: Array<() => Promise<void>> = []
      await operation({
        transactionalEm,
        registerPostCommitEffect: (effect) => {
          effects.push(effect)
        },
      })
      for (const effect of effects) await effect()
      return {
      status: 'expired',
      changed: false,
      mirrorChanged: false,
      staleGeneration: false,
      operationApplied: true,
    }
  },
  )
  const em = {
    count: jest.fn(async () => candidates.length),
    find: jest.fn(async () => candidates),
    findOne: jest.fn(async () => ({ reconciliationGeneration: 7 })),
  }
  const container = {
    hasRegistration: jest.fn(() => true),
    resolve: jest.fn((name: string) => name === 'finooIdentityRetention'
      ? { anonymizeAndDeleteForPerson }
      : { runIdentityErasureIfAuthoritativelyDue }),
  }
  const executor = createFinooIdentityErasureExecutor({ em, container,
  } as never)
  return {
    executor,
    em,
    container,
    anonymizeAndDeleteForPerson,
    runIdentityErasureIfAuthoritativelyDue,
    transactionalEm,
  }
}

describe('Finoo identity erasure executor', () => {
  it('reports only bounded counts in dry-run without resolving or calling identity retention', async () => {
    const harness = createHarness([
      { id: 'state-1', customerEntityId: 'person-1' },
      { id: 'state-2', customerEntityId: 'person-2' },
    ])

    await expect(harness.executor.execute({
      tenantId,
      organizationId,
      apply: false,
      batchSize: 1,
      now,
    })).resolves.toEqual({ eligibleCount: 2, selectedCount: 1, processedCount: 0,
    })

    expect(harness.em.find).not.toHaveBeenCalled()
    expect(harness.container.resolve).not.toHaveBeenCalled()
    expect(harness.anonymizeAndDeleteForPerson).not.toHaveBeenCalled()
  })

  it('selects only due expired states in the exact scope with deterministic bounded ordering', async () => {
    const harness = createHarness([{ id: 'state-1', customerEntityId: 'person-1' }])

    await harness.executor.execute({ tenantId, organizationId, apply: true, batchSize: 25, now,
    })

    const predicate = {
      tenantId,
      organizationId,
      retentionStatus: 'expired',
      retentionExpiresAt: { $lte: now },
      identityErasedAt: null,
      deletedAt: null,
    }
    expect(harness.em.count).toHaveBeenCalledWith(FinooCustomerRetentionState, predicate)
    expect(harness.em.find).toHaveBeenCalledWith(FinooCustomerRetentionState, predicate, {
      fields: ['id', 'customerEntityId'],
      orderBy: { customerEntityId: 'ASC', id: 'ASC' },
      limit: 25,
    })
  })

  it('uses only the narrow idempotent identity retention port for each selected person', async () => {
    const harness = createHarness([
      { id: 'state-1', customerEntityId: 'person-1' },
      { id: 'state-2', customerEntityId: 'person-2' },
    ])

    await expect(harness.executor.execute({
      tenantId,
      organizationId,
      apply: true,
      now,
    })).resolves.toEqual({ eligibleCount: 2, selectedCount: 2, processedCount: 2,
    })

    expect(harness.container.resolve).toHaveBeenCalledWith('finooIdentityRetention')
    expect(harness.container.resolve).toHaveBeenCalledWith('finooCustomerRetentionProjectionService')
    expect(harness.runIdentityErasureIfAuthoritativelyDue).toHaveBeenNthCalledWith(1, {
      tenantId,
      organizationId,
      customerEntityId: 'person-1',
      reconciliationGeneration: 7,
    }, expect.any(Function))
    expect(harness.anonymizeAndDeleteForPerson).toHaveBeenNthCalledWith(1, {
      tenantId,
      organizationId,
      personId: 'person-1',
      systemActor: true,
      transactionalEm: harness.transactionalEm,
      registerPostCommitEffect: expect.any(Function),
    })
    expect(harness.anonymizeAndDeleteForPerson).toHaveBeenNthCalledWith(2, {
      tenantId,
      organizationId,
      personId: 'person-2',
      systemActor: true,
      transactionalEm: harness.transactionalEm,
      registerPostCommitEffect: expect.any(Function),
    })
  })

  it('advances across bounded batches and finishes with zero pending erasures', async () => {
    const harness = createHarness()
    harness.em.count
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0)
    harness.em.find
      .mockResolvedValueOnce([{ id: 'state-1', customerEntityId: 'person-1' }])
      .mockResolvedValueOnce([{ id: 'state-2', customerEntityId: 'person-2' }])

    await expect(harness.executor.execute({
      tenantId, organizationId, apply: true, batchSize: 1, now,
    })).resolves.toEqual({ eligibleCount: 2, selectedCount: 1, processedCount: 1,
    })
    await expect(harness.executor.execute({
      tenantId, organizationId, apply: true, batchSize: 1, now,
    })).resolves.toEqual({ eligibleCount: 1, selectedCount: 1, processedCount: 1,
    })
    await expect(harness.executor.execute({
      tenantId, organizationId, apply: false, batchSize: 1, now,
    })).resolves.toEqual({ eligibleCount: 0, selectedCount: 0, processedCount: 0,
    })
    expect(harness.anonymizeAndDeleteForPerson.mock.calls.map(([request]) => request.personId)).toEqual([
      'person-1',
      'person-2',
    ])
  })

  it('does not erase when authoritative reconciliation makes a stale candidate active', async () => {
    const harness = createHarness([{ id: 'state-1', customerEntityId: 'person-1' }])
    harness.runIdentityErasureIfAuthoritativelyDue.mockResolvedValueOnce({
      status: 'active',
      changed: true,
      mirrorChanged: true,
      staleGeneration: false,
      operationApplied: false,
    })

    await expect(harness.executor.execute({
      tenantId, organizationId, apply: true, now,
    })).resolves.toEqual({ eligibleCount: 1, selectedCount: 1, processedCount: 0,
    })
    expect(harness.anonymizeAndDeleteForPerson).not.toHaveBeenCalled()
  })

  it('rejects unbounded service calls before querying or erasing', async () => {
    const harness = createHarness([{ id: 'state-1', customerEntityId: 'person-1' }])

    await expect(harness.executor.execute({
      tenantId,
      organizationId,
      apply: true,
      batchSize: 501,
      now,
    })).rejects.toThrow('Identity erasure batch size is outside the allowed range')
    expect(harness.em.count).not.toHaveBeenCalled()
    expect(harness.anonymizeAndDeleteForPerson).not.toHaveBeenCalled()
  })

  it('fails closed when the narrow identity retention port is absent', async () => {
    const harness = createHarness([{ id: 'state-1', customerEntityId: 'person-1' }])
    harness.container.hasRegistration.mockReturnValue(false)

    await expect(harness.executor.execute({
      tenantId,
      organizationId,
      apply: true,
      now,
    })).rejects.toThrow('Finoo identity retention port is unavailable')
    expect(harness.em.find).not.toHaveBeenCalled()
  })

  it('propagates erasure errors and stops before later people', async () => {
    const harness = createHarness([
      { id: 'state-1', customerEntityId: 'person-1' },
      { id: 'state-2', customerEntityId: 'person-2' },
    ])
    harness.anonymizeAndDeleteForPerson.mockRejectedValueOnce(new Error('identity erasure failed'))

    await expect(harness.executor.execute({
      tenantId,
      organizationId,
      apply: true,
      now,
    })).rejects.toThrow('identity erasure failed')
    expect(harness.anonymizeAndDeleteForPerson).toHaveBeenCalledTimes(1)
  })
})
