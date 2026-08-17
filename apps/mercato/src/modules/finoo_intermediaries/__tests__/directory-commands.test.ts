/** @jest-environment node */

import type { EntityManager } from '@mikro-orm/postgresql'
import {
  CustomerRole,
  CustomerUser,
  CustomerUserInvitation,
  CustomerUserRole,
  CustomerUserSession,
} from '@open-mercato/core/modules/customer_accounts/data/entities'
import type { CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { commandRegistry } from '@open-mercato/shared/lib/commands/registry'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { FinooIntermediary } from '../data/entities'

const mockSendInvitation = jest.fn(async () => undefined)
const mockSendAccessNotice = jest.fn(async () => undefined)
const mockEmitEvent = jest.fn(async () => undefined)
const mockEnforceOptimisticLock = jest.fn(async () => undefined)
const mockLoadRole = jest.fn()
const mockLoadDirectoryByEmail = jest.fn()
const mockLoadDirectoryById = jest.fn()
const mockLoadInvitation = jest.fn()
const mockLoadUserByEmail = jest.fn()
const mockLoadUser = jest.fn()
const mockLoadMembership = jest.fn()
const mockRestoreMembership = jest.fn()
const mockLockSessions = jest.fn()

jest.mock('@open-mercato/core/modules/customer_accounts/lib/invitationEmail', () => ({
  sendCustomerInvitationEmail: (...args: unknown[]) => mockSendInvitation(...args),
}))

jest.mock('../lib/directory-email', () => ({
  sendIntermediaryAccessNotice: (...args: unknown[]) => mockSendAccessNotice(...args),
}))

jest.mock('../events', () => ({
  emitFinooIntermediaryEvent: (...args: unknown[]) => mockEmitEvent(...args),
}))

jest.mock('@open-mercato/shared/lib/crud/optimistic-lock-command', () => ({
  enforceCommandOptimisticLockWithGuards: (...args: unknown[]) => mockEnforceOptimisticLock(...args),
}))

jest.mock('../lib/directory-lifecycle', () => ({
  directoryConflict: (code: string) => new CrudHttpError(409, { error: 'conflict', code }),
  directoryNotFound: () => new CrudHttpError(404, { error: 'not found' }),
  intermediaryEmailHash: (email: string) => `hash:${email.trim().toLowerCase()}`,
  normalizeIntermediaryEmail: (email: string) => email.trim().toLowerCase(),
  loadIntermediaryRole: (...args: unknown[]) => mockLoadRole(...args),
  loadDirectoryByEmail: (...args: unknown[]) => mockLoadDirectoryByEmail(...args),
  loadDirectoryById: (...args: unknown[]) => mockLoadDirectoryById(...args),
  loadCurrentInvitation: (...args: unknown[]) => mockLoadInvitation(...args),
  loadScopedCustomerUserByEmail: (...args: unknown[]) => mockLoadUserByEmail(...args),
  loadScopedCustomerUser: (...args: unknown[]) => mockLoadUser(...args),
  loadIntermediaryMembership: (...args: unknown[]) => mockLoadMembership(...args),
  restoreIntermediaryMembership: (...args: unknown[]) => mockRestoreMembership(...args),
  lockActiveUserSessions: (...args: unknown[]) => mockLockSessions(...args),
}))

import '../commands/directory'

const tenantId = '11111111-1111-4111-8111-111111111111'
const organizationId = '22222222-2222-4222-8222-222222222222'
const actorUserId = '33333333-3333-4333-8333-333333333333'
const intermediaryId = '44444444-4444-4444-8444-444444444444'
const userId = '55555555-5555-4555-8555-555555555555'
const roleId = '66666666-6666-4666-8666-666666666666'
const invitationId = '77777777-7777-4777-8777-777777777777'
const updatedAt = new Date('2026-08-17T12:00:00.000Z')

type MockEntityManager = Pick<
  EntityManager,
  'fork' | 'transactional' | 'persist' | 'flush' | 'nativeUpdate' | 'clear'
>

function makeIntermediary(state: FinooIntermediary['lifecycleState'] = 'invited'): FinooIntermediary {
  const intermediary = new FinooIntermediary()
  intermediary.id = intermediaryId
  intermediary.tenantId = tenantId
  intermediary.organizationId = organizationId
  intermediary.firstName = 'Sensitive'
  intermediary.lastName = 'Person'
  intermediary.email = 'sensitive@example.com'
  intermediary.emailHash = 'hash:sensitive@example.com'
  intermediary.lifecycleState = state
  intermediary.invitationId = invitationId
  intermediary.invitationExpiresAt = new Date('2026-08-20T12:00:00.000Z')
  intermediary.updatedAt = new Date(updatedAt)
  intermediary.createdAt = new Date(updatedAt)
  return intermediary
}

function makeUser(active = true): CustomerUser {
  const user = new CustomerUser()
  user.id = userId
  user.tenantId = tenantId
  user.organizationId = organizationId
  user.email = 'sensitive@example.com'
  user.emailHash = 'hash:sensitive@example.com'
  user.displayName = 'Sensitive Person'
  user.isActive = active
  return user
}

function makeRole(): CustomerRole {
  const role = new CustomerRole()
  role.id = roleId
  role.tenantId = tenantId
  role.organizationId = organizationId
  role.name = 'Intermediary'
  role.slug = 'intermediary'
  return role
}

function makeMembership(user: CustomerUser, role: CustomerRole): CustomerUserRole {
  const membership = new CustomerUserRole()
  membership.id = '88888888-8888-4888-8888-888888888888'
  membership.user = user
  membership.role = role
  membership.deletedAt = null
  return membership
}

function createHarness() {
  let nextId = 1
  const em: jest.Mocked<MockEntityManager> = {
    fork: jest.fn(),
    transactional: jest.fn(),
    persist: jest.fn(),
    flush: jest.fn(async () => undefined),
    nativeUpdate: jest.fn(async () => 1),
    clear: jest.fn(),
  }
  em.fork.mockReturnValue(em as unknown as EntityManager)
  em.transactional.mockImplementation(async (callback) => callback(em as unknown as EntityManager))
  em.persist.mockImplementation((entity: object) => {
    if ('id' in entity && !entity.id) {
      Object.assign(entity, { id: `99999999-9999-4999-8999-${String(nextId++).padStart(12, '0')}` })
    }
    return em as unknown as EntityManager
  })
  const userHasAllFeatures = jest.fn(async () => true)
  const invalidateUserCache = jest.fn(async () => undefined)
  const createInvitation = jest.fn(async () => {
    const invitation = new CustomerUserInvitation()
    invitation.id = invitationId
    invitation.tenantId = tenantId
    invitation.organizationId = organizationId
    invitation.email = 'sensitive@example.com'
    invitation.emailHash = 'hash:sensitive@example.com'
    invitation.token = 'hashed-token'
    invitation.roleIdsJson = [roleId]
    invitation.expiresAt = new Date('2026-08-20T12:00:00.000Z')
    return { invitation, rawToken: 'raw-secret-token', reused: false, rollbackState: null }
  })
  const container = {
    resolve(token: string) {
      if (token === 'em') return em
      if (token === 'rbacService') return { userHasAllFeatures }
      if (token === 'customerRbacService') return { invalidateUserCache }
      if (token === 'customerInvitationService') return { createInvitation }
      throw new Error(`Unexpected dependency: ${token}`)
    },
  }
  const ctx = {
    container,
    auth: {
      sub: 'interactive-subject',
      userId: actorUserId,
      tenantId,
      orgId: organizationId,
    },
    organizationScope: null,
    selectedOrganizationId: organizationId,
    organizationIds: [organizationId],
  } as unknown as CommandRuntimeContext
  return { em, ctx, userHasAllFeatures, invalidateUserCache, createInvitation }
}

describe('finoo_intermediaries directory commands', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockLoadRole.mockResolvedValue(makeRole())
    mockLoadDirectoryByEmail.mockResolvedValue(null)
    mockLoadDirectoryById.mockImplementation(async () => makeIntermediary())
    mockLoadInvitation.mockResolvedValue(null)
    mockLoadUserByEmail.mockResolvedValue(null)
    mockLoadUser.mockResolvedValue(makeUser())
    mockLoadMembership.mockResolvedValue(null)
    mockRestoreMembership.mockResolvedValue({ membership: makeMembership(makeUser(), makeRole()), changed: true })
    mockLockSessions.mockResolvedValue([])
  })

  it('registers every lifecycle command as explicitly non-undoable', () => {
    const ids = [
      'finoo_intermediaries.intermediary.invite',
      'finoo_intermediaries.intermediary.update',
      'finoo_intermediaries.invitation.resend',
      'finoo_intermediaries.invitation.cancel',
      'finoo_intermediaries.intermediary.activate_from_invitation',
      'finoo_intermediaries.intermediary.deactivate',
      'finoo_intermediaries.intermediary.reactivate',
    ]
    for (const id of ids) {
      const command = commandRegistry.get(id)
      expect(command).toBeDefined()
      expect(command?.isUndoable).toBe(false)
      expect(command?.undo).toBeUndefined()
    }
  })

  it('builds an invitation action log without email, names, or raw redo input', async () => {
    const command = commandRegistry.get('finoo_intermediaries.intermediary.invite')
    const intermediary = makeIntermediary('delivery_failed')
    const metadata = await command?.buildLog?.({
      input: {
        email: 'sensitive@example.com',
        firstName: 'Sensitive',
        lastName: 'Person',
      },
      result: { intermediary },
      ctx: createHarness().ctx,
      snapshots: {},
    })

    expect(metadata?.actorUserId).toBe(actorUserId)
    expect(metadata?.payload).toEqual({ __redoInput: {} })
    expect(JSON.stringify(metadata)).not.toContain('sensitive@example.com')
    expect(JSON.stringify(metadata)).not.toContain('Sensitive')
    expect(JSON.stringify(metadata)).not.toContain('raw-secret-token')
  })

  it('fails closed when the command context has no real staff user UUID', async () => {
    const harness = createHarness()
    const command = commandRegistry.get('finoo_intermediaries.intermediary.invite')
    const invalidCtx = {
      ...harness.ctx,
      auth: { sub: 'api_key:key-1', tenantId, orgId: organizationId, isApiKey: true },
    } as CommandRuntimeContext

    await expect(command?.execute({
      email: 'sensitive@example.com',
      firstName: 'Sensitive',
      lastName: 'Person',
    }, invalidCtx)).rejects.toMatchObject<Partial<CrudHttpError>>({
      status: 400,
      body: expect.objectContaining({ code: 'interactive_actor_required' }),
    })
  })

  it('cancels the locked invitation and preserves the durable directory row as inactive', async () => {
    const harness = createHarness()
    const intermediary = makeIntermediary('invited')
    const invitation = new CustomerUserInvitation()
    invitation.id = invitationId
    invitation.tenantId = tenantId
    invitation.organizationId = organizationId
    invitation.expiresAt = new Date('2026-08-20T12:00:00.000Z')
    invitation.acceptedAt = null
    invitation.cancelledAt = null
    mockLoadDirectoryById.mockResolvedValue(intermediary)
    mockLoadInvitation.mockResolvedValue(invitation)

    const command = commandRegistry.get('finoo_intermediaries.invitation.cancel')
    const result = await command?.execute({
      intermediaryId,
      expectedUpdatedAt: updatedAt.toISOString(),
    }, harness.ctx)

    expect(invitation.cancelledAt).toBeInstanceOf(Date)
    expect(intermediary.lifecycleState).toBe('inactive')
    expect(intermediary.deletedAt).toBeFalsy()
    expect(mockLoadInvitation).toHaveBeenCalledWith(
      expect.anything(), invitationId, { tenantId, organizationId, actorUserId }, true,
    )
    expect(mockEmitEvent).toHaveBeenCalledWith(
      'finoo_intermediaries.intermediary.invitation_cancelled',
      expect.objectContaining({ id: intermediaryId, actorUserId }),
      { persistent: true },
    )
    expect(result).toMatchObject({ intermediary: { lifecycleState: 'inactive' } })
  })

  it('deactivates the whole account, exact membership, and every active session before post-commit RBAC invalidation', async () => {
    const harness = createHarness()
    const intermediary = makeIntermediary('active')
    intermediary.customerUserId = userId
    const user = makeUser(true)
    const role = makeRole()
    const membership = makeMembership(user, role)
    const sessions = [new CustomerUserSession(), new CustomerUserSession()]
    sessions[0].deletedAt = null
    sessions[1].deletedAt = null
    mockLoadDirectoryById.mockResolvedValue(intermediary)
    mockLoadUser.mockResolvedValue(user)
    mockLoadRole.mockResolvedValue(role)
    mockLoadMembership.mockResolvedValue(membership)
    mockLockSessions.mockResolvedValue(sessions)

    const command = commandRegistry.get('finoo_intermediaries.intermediary.deactivate')
    await command?.execute({
      intermediaryId,
      expectedUpdatedAt: updatedAt.toISOString(),
    }, harness.ctx)

    expect(user.isActive).toBe(false)
    expect(user.sessionsRevokedAt).toBeInstanceOf(Date)
    expect(membership.deletedAt).toBeInstanceOf(Date)
    expect(sessions.every((session) => session.deletedAt instanceof Date)).toBe(true)
    expect(intermediary.lifecycleState).toBe('inactive')
    expect(harness.invalidateUserCache).toHaveBeenCalledWith(userId)
    expect(harness.em.flush.mock.invocationCallOrder[0]).toBeLessThan(
      harness.invalidateUserCache.mock.invocationCallOrder[0],
    )
  })

  it('links a pending email edit to an existing active account without creating an invitation', async () => {
    const harness = createHarness()
    const intermediary = makeIntermediary('invited')
    const targetUser = makeUser(true)
    targetUser.email = 'owned-active@example.com'
    targetUser.emailHash = 'hash:owned-active@example.com'
    const invitation = new CustomerUserInvitation()
    invitation.id = invitationId
    invitation.tenantId = tenantId
    invitation.organizationId = organizationId
    invitation.expiresAt = new Date('2026-08-20T12:00:00.000Z')
    invitation.acceptedAt = null
    invitation.cancelledAt = null
    mockLoadDirectoryById.mockResolvedValue(intermediary)
    mockLoadDirectoryByEmail.mockResolvedValue(null)
    mockLoadUserByEmail.mockResolvedValue(targetUser)
    mockLoadInvitation.mockResolvedValue(invitation)

    const command = commandRegistry.get('finoo_intermediaries.intermediary.update')
    const result = await command?.execute({
      intermediaryId,
      email: targetUser.email,
      firstName: 'Updated',
      lastName: 'Owner',
      expectedUpdatedAt: updatedAt.toISOString(),
    }, harness.ctx)

    expect(invitation.cancelledAt).toBeInstanceOf(Date)
    expect(mockRestoreMembership).toHaveBeenCalledWith(expect.anything(), targetUser, expect.any(CustomerRole))
    expect(harness.createInvitation).not.toHaveBeenCalled()
    expect(mockSendInvitation).not.toHaveBeenCalled()
    expect(mockSendAccessNotice).toHaveBeenCalledWith(expect.objectContaining({
      email: targetUser.email,
      tenantId,
      organizationId,
    }))
    expect(intermediary).toMatchObject({
      customerUserId: targetUser.id,
      lifecycleState: 'active',
      invitationId: null,
      invitationExpiresAt: null,
      email: targetUser.email,
    })
    expect(result).toMatchObject({ intermediary: { lifecycleState: 'active' } })
    expect(mockEmitEvent).toHaveBeenCalledWith(
      'finoo_intermediaries.intermediary.updated',
      expect.objectContaining({ invitationId: null, customerUserId: targetUser.id }),
      { persistent: true },
    )
    expect(mockEmitEvent).toHaveBeenCalledWith(
      'finoo_intermediaries.intermediary.activated',
      expect.objectContaining({ invitationId: null, customerUserId: targetUser.id }),
      { persistent: true },
    )
    expect(mockEmitEvent).not.toHaveBeenCalledWith(
      'finoo_intermediaries.intermediary.invited',
      expect.anything(),
      expect.anything(),
    )
  })

  it('links a pending email edit to an existing inactive account without role or mail changes', async () => {
    const harness = createHarness()
    const intermediary = makeIntermediary('delivery_failed')
    const targetUser = makeUser(false)
    targetUser.email = 'owned-inactive@example.com'
    targetUser.emailHash = 'hash:owned-inactive@example.com'
    const invitation = new CustomerUserInvitation()
    invitation.id = invitationId
    invitation.tenantId = tenantId
    invitation.organizationId = organizationId
    invitation.expiresAt = new Date('2026-08-20T12:00:00.000Z')
    invitation.acceptedAt = null
    invitation.cancelledAt = null
    mockLoadDirectoryById.mockResolvedValue(intermediary)
    mockLoadDirectoryByEmail.mockResolvedValue(null)
    mockLoadUserByEmail.mockResolvedValue(targetUser)
    mockLoadInvitation.mockResolvedValue(invitation)

    const command = commandRegistry.get('finoo_intermediaries.intermediary.update')
    const result = await command?.execute({
      intermediaryId,
      email: targetUser.email,
      firstName: 'Updated',
      lastName: 'Inactive',
      expectedUpdatedAt: updatedAt.toISOString(),
    }, harness.ctx)

    expect(invitation.cancelledAt).toBeInstanceOf(Date)
    expect(mockRestoreMembership).not.toHaveBeenCalled()
    expect(harness.createInvitation).not.toHaveBeenCalled()
    expect(mockSendInvitation).not.toHaveBeenCalled()
    expect(mockSendAccessNotice).not.toHaveBeenCalled()
    expect(harness.invalidateUserCache).not.toHaveBeenCalled()
    expect(intermediary).toMatchObject({
      customerUserId: targetUser.id,
      lifecycleState: 'inactive',
      invitationId: null,
      invitationExpiresAt: null,
      email: targetUser.email,
    })
    expect(result).toMatchObject({
      intermediary: { lifecycleState: 'inactive' },
      requiresReactivation: true,
    })
    expect(mockEmitEvent).toHaveBeenCalledWith(
      'finoo_intermediaries.intermediary.updated',
      expect.objectContaining({
        status: 'inactive',
        invitationId: null,
        customerUserId: targetUser.id,
      }),
      { persistent: true },
    )
  })

  it('does not let a failed stale delivery result overwrite a later lifecycle lineage', async () => {
    const harness = createHarness()
    const current = makeIntermediary('inactive')
    current.updatedAt = new Date('2026-08-17T13:00:00.000Z')
    mockSendInvitation.mockRejectedValueOnce(new Error('provider detail with recipient data'))
    harness.em.nativeUpdate.mockResolvedValueOnce(0)
    mockLoadDirectoryById.mockImplementation(async () => current)

    const command = commandRegistry.get('finoo_intermediaries.intermediary.invite')
    const result = await command?.execute({
      email: 'sensitive@example.com',
      firstName: 'Sensitive',
      lastName: 'Person',
    }, harness.ctx)

    expect(harness.em.nativeUpdate).toHaveBeenCalledWith(
      FinooIntermediary,
      expect.objectContaining({ invitationId, updatedAt: expect.any(Date) }),
      expect.objectContaining({ lastEmailErrorCode: 'email_delivery_failed' }),
    )
    expect(result).toEqual({ intermediary: current })
    expect(current.lifecycleState).toBe('inactive')
    expect(mockEmitEvent).not.toHaveBeenCalledWith(
      'finoo_intermediaries.intermediary.invitation_delivery_failed',
      expect.anything(),
      expect.anything(),
    )
  })
})
