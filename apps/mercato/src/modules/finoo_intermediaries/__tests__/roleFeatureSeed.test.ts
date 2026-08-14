import { LockMode, type EntityManager } from '@mikro-orm/postgresql'
import { CustomerRole, CustomerRoleAcl } from '@open-mercato/core/modules/customer_accounts/data/entities'
import commands, { parseEnsurePortalRoleFeatureArgs } from '../cli'
import {
  ensureIntermediaryPortalRoleFeature,
  INTERMEDIARY_PORTAL_FEATURE,
} from '../lib/roleFeatureSeed'

const scope = {
  tenantId: '22222222-2222-4222-8222-222222222222',
  organizationId: '33333333-3333-4333-8333-333333333333',
}

function createHarness(roleResult: unknown, aclResult: unknown) {
  const transactionalEm = {
    findOne: jest.fn()
      .mockResolvedValueOnce(roleResult)
      .mockResolvedValueOnce(aclResult),
    persist: jest.fn(),
    flush: jest.fn().mockResolvedValue(undefined),
  }
  const em = {
    transactional: jest.fn(async (run: (tx: typeof transactionalEm) => Promise<unknown>) => run(transactionalEm)),
  } as unknown as EntityManager
  const customerRbacService = { invalidateTenantCache: jest.fn().mockResolvedValue(undefined) }
  return { em, transactionalEm, customerRbacService }
}

describe('finoo intermediary role feature seed', () => {
  it('requires one exact UUID scope and an explicit apply flag', () => {
    expect(parseEnsurePortalRoleFeatureArgs([
      '--tenant', scope.tenantId,
      '--organization', scope.organizationId,
      '--apply',
    ])).toEqual(scope)
    expect(parseEnsurePortalRoleFeatureArgs(['--tenant', scope.tenantId, '--apply'])).toBeNull()
    expect(parseEnsurePortalRoleFeatureArgs([
      '--tenant', scope.tenantId,
      '--organization', scope.organizationId,
    ])).toBeNull()
    expect(parseEnsurePortalRoleFeatureArgs([
      '--tenant', 'not-a-uuid',
      '--organization', scope.organizationId,
      '--apply',
    ])).toBeNull()
  })

  it('fails the CLI command instead of reporting success for an invalid scope', async () => {
    await expect(commands[0].run([
      '--tenant', scope.tenantId,
      '--apply',
    ])).rejects.toThrow('Invalid arguments')
  })

  it('locks the exact role then ACL, preserves features, and bumps the role version', async () => {
    const now = new Date('2026-08-14T12:00:00.000Z')
    const role = { id: 'role-1', updatedAt: new Date('2026-08-13T12:00:00.000Z') }
    const acl = { id: 'acl-1', featuresJson: ['portal.account.manage'] }
    const harness = createHarness(role, acl)

    await expect(ensureIntermediaryPortalRoleFeature(
      harness.em,
      harness.customerRbacService,
      scope,
      now,
    )).resolves.toEqual({ changed: true, roleId: role.id, feature: INTERMEDIARY_PORTAL_FEATURE })

    expect(harness.transactionalEm.findOne).toHaveBeenNthCalledWith(1, CustomerRole, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      slug: 'intermediary',
      deletedAt: null,
    }, { lockMode: LockMode.PESSIMISTIC_WRITE })
    expect(harness.transactionalEm.findOne).toHaveBeenNthCalledWith(2, CustomerRoleAcl, {
      role: role.id,
      tenantId: scope.tenantId,
      deletedAt: null,
    }, { lockMode: LockMode.PESSIMISTIC_WRITE })
    expect(acl.featuresJson).toEqual(['portal.account.manage', INTERMEDIARY_PORTAL_FEATURE])
    expect(role.updatedAt).toBe(now)
    expect(harness.transactionalEm.persist.mock.calls).toEqual([[acl], [role]])
    expect(harness.transactionalEm.flush).toHaveBeenCalledTimes(1)
    expect(harness.customerRbacService.invalidateTenantCache).toHaveBeenCalledWith(scope.tenantId)
  })

  it('keeps an existing grant unchanged and still clears a potentially stale cache', async () => {
    const role = { id: 'role-1', updatedAt: new Date('2026-08-13T12:00:00.000Z') }
    const acl = { id: 'acl-1', featuresJson: [INTERMEDIARY_PORTAL_FEATURE] }
    const harness = createHarness(role, acl)

    await expect(ensureIntermediaryPortalRoleFeature(
      harness.em,
      harness.customerRbacService,
      scope,
    )).resolves.toEqual({ changed: false, roleId: role.id, feature: INTERMEDIARY_PORTAL_FEATURE })

    expect(harness.transactionalEm.persist).not.toHaveBeenCalled()
    expect(harness.transactionalEm.flush).not.toHaveBeenCalled()
    expect(harness.customerRbacService.invalidateTenantCache).toHaveBeenCalledWith(scope.tenantId)
  })

  it.each([
    ['role', null, null, 'Scoped intermediary role not found'],
    ['ACL', { id: 'role-1' }, null, 'Scoped intermediary role ACL not found'],
  ])('fails closed when the scoped %s is absent', async (_label, role, acl, message) => {
    const harness = createHarness(role, acl)

    await expect(ensureIntermediaryPortalRoleFeature(
      harness.em,
      harness.customerRbacService,
      scope,
    )).rejects.toThrow(message)

    expect(harness.transactionalEm.persist).not.toHaveBeenCalled()
    expect(harness.transactionalEm.flush).not.toHaveBeenCalled()
    expect(harness.customerRbacService.invalidateTenantCache).not.toHaveBeenCalled()
  })

  it('does not invalidate cache when the transaction fails before commit', async () => {
    const role = { id: 'role-1' }
    const acl = { id: 'acl-1', featuresJson: [] }
    const harness = createHarness(role, acl)
    harness.transactionalEm.flush.mockRejectedValueOnce(new Error('commit failed'))

    await expect(ensureIntermediaryPortalRoleFeature(
      harness.em,
      harness.customerRbacService,
      scope,
    )).rejects.toThrow('commit failed')

    expect(harness.customerRbacService.invalidateTenantCache).not.toHaveBeenCalled()
  })
})
