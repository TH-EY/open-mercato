import type { EntityManager } from '@mikro-orm/postgresql'
import { hashForLookup } from '@open-mercato/shared/lib/encryption/aes'
import commands, { parseBackfillDirectoryArgs } from '../cli'
import {
  backfillIntermediaryDirectory,
  deriveIntermediaryBackfillName,
  IntermediaryBackfillError,
  planIntermediaryDirectoryBackfill,
  requireSingleScopedIntermediaryRole,
  type IntermediaryBackfillPlan,
} from '../lib/directoryBackfill'

const scope = {
  tenantId: '22222222-2222-4222-8222-222222222222',
  organizationId: '33333333-3333-4333-8333-333333333333',
}

const userId = '44444444-4444-4444-8444-444444444444'
const otherUserId = '55555555-5555-4555-8555-555555555555'
const roleId = '66666666-6666-4666-8666-666666666666'
const email = 'person@example.test'

function createPlan(action: 'create' | 'unchanged' = 'create'): IntermediaryBackfillPlan {
  return {
    roleId,
    entries: action === 'create'
      ? [{
          action: 'create',
          customerUserId: userId,
          email,
          emailHash: hashForLookup(email),
          firstName: 'Sensitive',
          lastName: 'Person',
        }]
      : [{ action: 'unchanged', customerUserId: userId, intermediaryId: '77777777-7777-4777-8777-777777777777' }],
  }
}

function createEm(options: { flushError?: Error } = {}) {
  const intermediaryClass = class TestFinooIntermediary {}
  const transactionalEm = {
    getMetadata: jest.fn(() => ({
      getByClassName: jest.fn(() => ({ class: intermediaryClass })),
    })),
    create: jest.fn((_entityClass: typeof intermediaryClass, data: Record<string, unknown>) => data),
    persist: jest.fn(),
    flush: options.flushError
      ? jest.fn().mockRejectedValue(options.flushError)
      : jest.fn().mockResolvedValue(undefined),
  }
  const em = {
    transactional: jest.fn(async (run: (tx: typeof transactionalEm) => Promise<unknown>) => run(transactionalEm)),
  } as unknown as EntityManager
  return { em, transactionalEm }
}

describe('finoo intermediary directory backfill', () => {
  it('keeps the existing CLI command first and adds the scoped backfill command second', () => {
    expect(commands.map((command) => command.command)).toEqual([
      'ensure-portal-role-feature',
      'backfill-directory',
    ])
  })

  it('requires exact UUID scope and exactly one strict mode', () => {
    expect(parseBackfillDirectoryArgs([
      '--tenant', scope.tenantId,
      '--organization', scope.organizationId,
      '--dry-run',
    ])).toEqual({ ...scope, mode: 'dry-run' })
    expect(parseBackfillDirectoryArgs([
      '--apply',
      '--organization', scope.organizationId,
      '--tenant', scope.tenantId,
    ])).toEqual({ ...scope, mode: 'apply' })
    expect(parseBackfillDirectoryArgs([
      '--tenant', scope.tenantId,
      '--organization', scope.organizationId,
    ])).toBeNull()
    expect(parseBackfillDirectoryArgs([
      '--tenant', scope.tenantId,
      '--organization', scope.organizationId,
      '--dry-run', '--apply',
    ])).toBeNull()
    expect(parseBackfillDirectoryArgs([
      '--tenant', scope.tenantId,
      '--organization', 'not-a-uuid',
      '--apply',
    ])).toBeNull()
    expect(parseBackfillDirectoryArgs([
      '--tenant', scope.tenantId,
      '--organization', scope.organizationId,
      '--apply', '--extra',
    ])).toBeNull()
  })

  it('prefers two non-empty CRM names and otherwise splits display name at the final whitespace', () => {
    expect(deriveIntermediaryBackfillName({
      displayName: 'Fallback Display',
      profile: { firstName: '  CRM First ', lastName: ' CRM Last  ' },
    })).toEqual({ firstName: 'CRM First', lastName: 'CRM Last' })
    expect(deriveIntermediaryBackfillName({
      displayName: 'Ada Maria Lovelace',
      profile: { firstName: 'Ada', lastName: '   ' },
    })).toEqual({ firstName: 'Ada Maria', lastName: 'Lovelace' })
  })

  it.each(['', 'SingleName', '   '])('fails closed for unsplittable display name %p', (displayName) => {
    expect(() => deriveIntermediaryBackfillName({ displayName })).toThrow(
      new IntermediaryBackfillError('name_unresolvable'),
    )
  })

  it('fails closed when the scoped role is missing or ambiguous', () => {
    expect(() => requireSingleScopedIntermediaryRole([])).toThrow('role_missing_or_ambiguous')
    expect(() => requireSingleScopedIntermediaryRole([{}, {}] as never)).toThrow('role_missing_or_ambiguous')
  })

  it('ignores an unavailable cross-scope profile and uses the scoped user display-name fallback', () => {
    const plan = planIntermediaryDirectoryBackfill({
      roleId,
      users: [{ id: userId, email, emailHash: hashForLookup(email), displayName: 'Scope Fallback', personEntityId: null }],
      profilesByUserId: new Map(),
      existingRows: [],
    })
    expect(plan.entries[0]).toMatchObject({ action: 'create', firstName: 'Scope', lastName: 'Fallback' })
  })

  it('keeps one aligned Active row unchanged without overwriting administrator names', () => {
    const intermediaryId = '77777777-7777-4777-8777-777777777777'
    const plan = planIntermediaryDirectoryBackfill({
      roleId,
      users: [{ id: userId, email, emailHash: hashForLookup(email), displayName: 'Portal Display', personEntityId: null }],
      profilesByUserId: new Map(),
      existingRows: [{
        id: intermediaryId,
        customerUserId: userId,
        emailHash: hashForLookup(email),
        lifecycleState: 'active',
        firstName: 'Admin',
        lastName: 'Owned',
      }],
    })
    expect(plan.entries).toEqual([{ action: 'unchanged', customerUserId: userId, intermediaryId }])
    expect(JSON.stringify(plan)).not.toContain('Admin')
    expect(JSON.stringify(plan)).not.toContain('Owned')
  })

  it('fails the full plan when user and email resolve to split rows or an aligned row is inactive', () => {
    const users = [{ id: userId, email, emailHash: hashForLookup(email), displayName: 'Portal Display', personEntityId: null }]
    expect(() => planIntermediaryDirectoryBackfill({
      roleId,
      users,
      profilesByUserId: new Map(),
      existingRows: [
        {
          id: '77777777-7777-4777-8777-777777777777',
          customerUserId: userId,
          emailHash: hashForLookup('different@example.test'),
          lifecycleState: 'active',
          firstName: 'A',
          lastName: 'B',
        },
        {
          id: '88888888-8888-4888-8888-888888888888',
          customerUserId: otherUserId,
          emailHash: hashForLookup(email),
          lifecycleState: 'active',
          firstName: 'C',
          lastName: 'D',
        },
      ],
    })).toThrow('directory_match_conflict')
    expect(() => planIntermediaryDirectoryBackfill({
      roleId,
      users,
      profilesByUserId: new Map(),
      existingRows: [{
        id: '77777777-7777-4777-8777-777777777777',
        customerUserId: userId,
        emailHash: hashForLookup(email),
        lifecycleState: 'inactive',
        firstName: 'A',
        lastName: 'B',
      }],
    })).toThrow('directory_match_conflict')
  })

  it('fails preflight when two eligible accounts resolve through the same email candidates', () => {
    expect(() => planIntermediaryDirectoryBackfill({
      roleId,
      users: [
        { id: userId, email, emailHash: hashForLookup(email), displayName: 'First User', personEntityId: null },
        { id: otherUserId, email, emailHash: hashForLookup(email), displayName: 'Second User', personEntityId: null },
      ],
      profilesByUserId: new Map(),
      existingRows: [],
    })).toThrow('customer_user_email_conflict')
  })

  it('keeps dry-run write-free and returns only sanitized internal identifiers and codes', async () => {
    const harness = createEm()
    const loadPlan = jest.fn().mockResolvedValue(createPlan())
    const report = await backfillIntermediaryDirectory({
      em: harness.em,
      scope,
      mode: 'dry-run',
    }, { loadPlan })

    expect(loadPlan).toHaveBeenCalledWith(harness.em, scope, { lock: false })
    expect(harness.em.transactional).not.toHaveBeenCalled()
    expect(harness.transactionalEm.persist).not.toHaveBeenCalled()
    expect(report.counts).toEqual({ eligible: 1, plannedCreates: 1, created: 0, unchanged: 0 })
    expect(report.records).toEqual([{ customerUserId: userId, code: 'would_create' }])
    expect(JSON.stringify(report)).not.toContain(email)
    expect(JSON.stringify(report)).not.toContain('Sensitive')
    expect(JSON.stringify(report)).not.toContain('Person')
  })

  it('applies inside one transaction and emits sanitized query-index work only after commit', async () => {
    const harness = createEm()
    const loadPlan = jest.fn().mockResolvedValue(createPlan())
    const eventBus = { emitEvent: jest.fn().mockResolvedValue(undefined) }
    const report = await backfillIntermediaryDirectory({
      em: harness.em,
      eventBus,
      scope,
      mode: 'apply',
      now: new Date('2026-08-17T15:00:00.000Z'),
    }, { loadPlan })

    expect(loadPlan).toHaveBeenCalledWith(harness.transactionalEm, scope, { lock: true })
    expect(harness.transactionalEm.persist).toHaveBeenCalledTimes(1)
    expect(harness.transactionalEm.create).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ customerUserId: userId, lifecycleState: 'active' }),
    )
    expect(harness.transactionalEm.flush).toHaveBeenCalledTimes(1)
    expect(eventBus.emitEvent).toHaveBeenCalledWith('query_index.upsert_one', expect.objectContaining({
      entityType: 'finoo_intermediaries:finoo_intermediary',
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      crudAction: 'created',
    }), scope)
    expect(JSON.stringify(eventBus.emitEvent.mock.calls)).not.toContain(email)
    expect(report.counts.created).toBe(1)
  })

  it('emits no index work when the transactional flush rolls back', async () => {
    const harness = createEm({ flushError: new Error('commit failed') })
    const eventBus = { emitEvent: jest.fn().mockResolvedValue(undefined) }
    await expect(backfillIntermediaryDirectory({
      em: harness.em,
      eventBus,
      scope,
      mode: 'apply',
    }, { loadPlan: jest.fn().mockResolvedValue(createPlan()) })).rejects.toThrow('commit failed')
    expect(eventBus.emitEvent).not.toHaveBeenCalled()
  })

  it('reports zero creates on a second apply after fresh revalidation', async () => {
    const harness = createEm()
    const loadPlan = jest.fn()
      .mockResolvedValueOnce(createPlan('create'))
      .mockResolvedValueOnce(createPlan('unchanged'))
    const first = await backfillIntermediaryDirectory({ em: harness.em, scope, mode: 'apply' }, { loadPlan })
    const second = await backfillIntermediaryDirectory({ em: harness.em, scope, mode: 'apply' }, { loadPlan })
    expect(first.counts.created).toBe(1)
    expect(second.counts).toEqual({ eligible: 1, plannedCreates: 0, created: 0, unchanged: 1 })
    expect(second.records).toEqual([{ customerUserId: userId, code: 'unchanged' }])
  })
})
