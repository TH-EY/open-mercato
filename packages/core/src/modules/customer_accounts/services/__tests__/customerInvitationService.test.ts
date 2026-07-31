/** @jest-environment node */
import type { EntityManager } from '@mikro-orm/postgresql'
import { CustomerInvitationService } from '@open-mercato/core/modules/customer_accounts/services/customerInvitationService'
import {
  CustomerRole,
  CustomerUser,
  CustomerUserInvitation,
  CustomerUserRole,
} from '@open-mercato/core/modules/customer_accounts/data/entities'

const mockIsOwnedCompanyEntity = jest.fn()

jest.mock('@open-mercato/core/modules/customer_accounts/lib/tokenGenerator', () => ({
  generateSecureToken: jest.fn(() => 'raw-token'),
  hashToken: jest.fn((value: string) => `hashed-${value}`),
}))

jest.mock('@open-mercato/shared/lib/encryption/aes', () => ({
  hashForLookup: jest.fn(() => 'email-hash'),
}))

jest.mock('bcryptjs', () => ({
  hash: jest.fn(async (value: string) => `hashed-${value}`),
}))

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findWithDecryption: (em: any, entity: any, where: any, options?: any) => em.find(entity, where, options),
  findOneWithDecryption: (em: any, entity: any, where: any, options?: any) => em.findOne(entity, where, options),
  findAndCountWithDecryption: (em: any, entity: any, where: any, options?: any) => em.findAndCount(entity, where, options),
}))

jest.mock('@open-mercato/core/modules/customer_accounts/lib/customerEntityOwnership', () => ({
  isOwnedCompanyEntity: (...args: unknown[]) => mockIsOwnedCompanyEntity(...args),
}))

describe('CustomerInvitationService.acceptInvitation — role lookup batching', () => {
  const roleIds = [
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  ]
  const tenantId = '11111111-1111-4111-8111-111111111111'
  const organizationId = '22222222-2222-4222-8222-222222222222'

  let mockEm: jest.Mocked<Pick<EntityManager, 'find' | 'findOne' | 'create' | 'persist' | 'flush' | 'nativeUpdate' | 'transactional'>>
  let service: CustomerInvitationService

  beforeEach(() => {
    jest.clearAllMocks()
    mockEm = {
      find: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn((_: unknown, data: unknown) => data as any),
      persist: jest.fn(),
      flush: jest.fn(async () => undefined),
      nativeUpdate: jest.fn(async () => 1),
      transactional: jest.fn(async (fn: (tx: EntityManager) => unknown) => fn(mockEm as unknown as EntityManager)),
    } as unknown as jest.Mocked<Pick<EntityManager, 'find' | 'findOne' | 'create' | 'persist' | 'flush' | 'nativeUpdate' | 'transactional'>>
    mockIsOwnedCompanyEntity.mockResolvedValue(true)
    service = new CustomerInvitationService(mockEm as unknown as EntityManager)
  })

  it('uses a single CustomerRole $in query for all invitation roleIds (not per-role findOne)', async () => {
    const invitation = {
      id: 'inv-1',
      email: 'new@example.com',
      tenantId,
      organizationId,
      customerEntityId: null,
      roleIdsJson: roleIds,
      expiresAt: new Date(Date.now() + 60_000),
      acceptedAt: null,
      cancelledAt: null,
    } as unknown as CustomerUserInvitation

    ;(mockEm.findOne as jest.Mock).mockImplementation(async (entity: unknown) => {
      if (entity === CustomerUserInvitation) return invitation
      return null
    })
    ;(mockEm.find as jest.Mock).mockImplementation(async (entity: unknown, where: any) => {
      if (entity === CustomerRole) {
        return (where.id.$in as string[]).map((id: string) => ({ id, tenantId, deletedAt: null }))
      }
      return []
    })

    const result = await service.acceptInvitation('raw-token', 'Secret123!', 'New User')
    expect(result).not.toBeNull()

    const roleFinds = (mockEm.find as jest.Mock).mock.calls.filter((call) => call[0] === CustomerRole)
    expect(roleFinds).toHaveLength(1)
      expect(roleFinds[0][1]).toMatchObject({
        id: { $in: roleIds },
        tenantId,
        organizationId,
        deletedAt: null,
      })
    expect(mockEm.findOne).not.toHaveBeenCalledWith(CustomerRole, expect.anything())
    expect(mockEm.nativeUpdate).toHaveBeenCalledWith(
      CustomerUserInvitation,
      expect.objectContaining({
        id: 'inv-1',
        tenantId,
        organizationId,
        token: 'hashed-raw-token',
        acceptedAt: null,
        cancelledAt: null,
      }),
      expect.objectContaining({ acceptedAt: expect.any(Date) }),
    )

    const linkCreates = (mockEm.create as jest.Mock).mock.calls.filter((call) => call[0] === CustomerUserRole)
    expect(linkCreates).toHaveLength(roleIds.length)
  })

  it('skips the role query entirely when the invitation carries no roleIds', async () => {
    const invitation = {
      id: 'inv-2',
      email: 'new@example.com',
      tenantId,
      organizationId,
      customerEntityId: null,
      roleIdsJson: [],
      expiresAt: new Date(Date.now() + 60_000),
      acceptedAt: null,
      cancelledAt: null,
    } as unknown as CustomerUserInvitation

    ;(mockEm.findOne as jest.Mock).mockImplementation(async (entity: unknown) => {
      if (entity === CustomerUserInvitation) return invitation
      return null
    })
    ;(mockEm.find as jest.Mock).mockResolvedValue([])

    await service.acceptInvitation('raw-token', 'Secret123!', 'New User')
    const roleFinds = (mockEm.find as jest.Mock).mock.calls.filter((call) => call[0] === CustomerRole)
    expect(roleFinds).toHaveLength(0)
  })

    it('does not create a user when a looked-up token was rotated before acceptance claim', async () => {
    const invitation = {
      id: 'inv-race',
      email: 'new@example.com',
      tenantId,
      organizationId,
      customerEntityId: null,
      roleIdsJson: roleIds,
      token: 'hashed-stale-token',
      expiresAt: new Date(Date.now() + 60_000),
      acceptedAt: null,
      cancelledAt: null,
    } as unknown as CustomerUserInvitation

      ;(mockEm.findOne as jest.Mock).mockResolvedValueOnce(invitation)
      ;(mockEm.find as jest.Mock).mockImplementation(async (entity: unknown, where: any) => {
        if (entity === CustomerRole) {
          return (where.id.$in as string[]).map((id: string) => ({ id, tenantId, organizationId, deletedAt: null }))
        }
        return []
      })
      ;(mockEm.nativeUpdate as jest.Mock).mockResolvedValueOnce(0)

    const result = await service.acceptInvitation('stale-token', 'Secret123!', 'New User')

    expect(result).toBeNull()
    expect(mockEm.nativeUpdate).toHaveBeenCalledWith(
      CustomerUserInvitation,
      expect.objectContaining({
        id: 'inv-race',
        token: 'hashed-stale-token',
        acceptedAt: null,
        cancelledAt: null,
      }),
      expect.objectContaining({ acceptedAt: expect.any(Date) }),
    )
    expect(mockEm.create).not.toHaveBeenCalledWith(CustomerUser, expect.anything())
    expect(mockEm.flush).not.toHaveBeenCalled()

    ;(mockEm.findOne as jest.Mock).mockResolvedValueOnce({
      ...invitation,
      token: 'hashed-fresh-token',
    })
    ;(mockEm.nativeUpdate as jest.Mock).mockResolvedValueOnce(1)

    const freshResult = await service.acceptInvitation('fresh-token', 'Secret123!', 'New User')

    expect(freshResult).not.toBeNull()
      expect(mockEm.create).toHaveBeenCalledWith(
        CustomerUser,
        expect.objectContaining({ email: 'new@example.com', passwordHash: 'hashed-Secret123!' }),
      )
    })

  it('does not claim an invitation when stored role ids are outside the invitation organization', async () => {
      const invitation = {
        id: 'inv-foreign-role',
        email: 'new@example.com',
        tenantId,
        organizationId,
        customerEntityId: null,
        roleIdsJson: roleIds,
        expiresAt: new Date(Date.now() + 60_000),
        acceptedAt: null,
        cancelledAt: null,
      } as unknown as CustomerUserInvitation

      ;(mockEm.findOne as jest.Mock).mockResolvedValueOnce(invitation)
      ;(mockEm.find as jest.Mock).mockImplementation(async (entity: unknown) => {
        if (entity === CustomerRole) return [{ id: roleIds[0], tenantId, organizationId, deletedAt: null }]
        return []
      })

      const result = await service.acceptInvitation('raw-token', 'Secret123!', 'New User')

      expect(result).toBeNull()
    expect(mockEm.nativeUpdate).not.toHaveBeenCalled()
    expect(mockEm.create).not.toHaveBeenCalledWith(CustomerUser, expect.anything())
  })

  it('does not claim an invitation when stored customerEntityId is outside the invitation organization', async () => {
    const foreignCustomerEntityId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    const invitation = {
      id: 'inv-foreign-company',
      email: 'new@example.com',
      tenantId,
      organizationId,
      customerEntityId: foreignCustomerEntityId,
      roleIdsJson: [],
      expiresAt: new Date(Date.now() + 60_000),
      acceptedAt: null,
      cancelledAt: null,
    } as unknown as CustomerUserInvitation

    ;(mockEm.findOne as jest.Mock).mockResolvedValueOnce(invitation)
    mockIsOwnedCompanyEntity.mockResolvedValueOnce(false)

    const result = await service.acceptInvitation('raw-token', 'Secret123!', 'New User')

    expect(result).toBeNull()
    expect(mockIsOwnedCompanyEntity).toHaveBeenCalledWith(mockEm, foreignCustomerEntityId, {
      tenantId,
      organizationId,
    })
    expect(mockEm.nativeUpdate).not.toHaveBeenCalled()
    expect(mockEm.create).not.toHaveBeenCalledWith(CustomerUser, expect.anything())
  })
})

describe('CustomerInvitationService.createInvitation — pending-invitation dedupe', () => {
  const roleIds = [
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  ]
  const tenantId = '11111111-1111-4111-8111-111111111111'
  const organizationId = '22222222-2222-4222-8222-222222222222'

  let mockEm: jest.Mocked<Pick<EntityManager, 'find' | 'findOne' | 'create' | 'persist' | 'flush' | 'nativeUpdate' | 'nativeDelete'>>
  let service: CustomerInvitationService

  beforeEach(() => {
    jest.clearAllMocks()
    mockEm = {
      find: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn((_: unknown, data: unknown) => data as any),
      persist: jest.fn(() => mockEm),
      flush: jest.fn(async () => undefined),
      nativeUpdate: jest.fn(async () => 1),
      nativeDelete: jest.fn(async () => 1),
    } as unknown as jest.Mocked<Pick<EntityManager, 'find' | 'findOne' | 'create' | 'persist' | 'flush' | 'nativeUpdate' | 'nativeDelete'>>
    service = new CustomerInvitationService(mockEm as unknown as EntityManager)
  })

  it('reuses an existing pending invitation instead of inserting a new row', async () => {
    const existing = {
      id: 'inv-existing',
      email: 'old@example.com',
      tenantId,
      organizationId,
      emailHash: 'email-hash',
      token: 'old-hashed-token',
      customerEntityId: null,
      roleIdsJson: ['old-role'],
      invitedByUserId: null,
      invitedByCustomerUserId: null,
      displayName: 'Old Name',
      expiresAt: new Date(Date.now() + 60_000),
      acceptedAt: null,
      cancelledAt: null,
    } as unknown as CustomerUserInvitation

    ;(mockEm.findOne as jest.Mock).mockImplementation(async (entity: unknown) => {
      if (entity === CustomerUserInvitation) return existing
      return null
    })

    const beforeExpiresAt = existing.expiresAt.getTime()
    const result = await service.createInvitation(
      ' New@Example.COM ',
      { tenantId, organizationId },
      { roleIds, invitedByUserId: 'inviter-1', displayName: 'Refreshed Name' },
    )

    expect(mockEm.create).not.toHaveBeenCalled()
    expect(result.invitation).toBe(existing)
    expect(result.rawToken).toBe('raw-token')
    expect(result.reused).toBe(true)
    expect(result.rollbackSnapshot).toMatchObject({
      email: 'old@example.com',
      token: 'old-hashed-token',
      roleIdsJson: ['old-role'],
      invitedByUserId: null,
      displayName: 'Old Name',
    })
    expect(existing.email).toBe('new@example.com')
    expect(existing.token).toBe('hashed-raw-token')
    expect(existing.roleIdsJson).toEqual(roleIds)
    expect(existing.invitedByUserId).toBe('inviter-1')
    expect(existing.displayName).toBe('Refreshed Name')
    expect(existing.expiresAt.getTime()).toBeGreaterThan(beforeExpiresAt)
    expect(mockEm.flush).toHaveBeenCalled()

    const dedupeFinds = (mockEm.findOne as jest.Mock).mock.calls.filter(
      (call) => call[0] === CustomerUserInvitation,
    )
    expect(dedupeFinds).toHaveLength(1)
    expect(dedupeFinds[0][1]).toMatchObject({
      tenantId,
      organizationId,
      emailHash: 'email-hash',
      acceptedAt: null,
      cancelledAt: null,
    })
    expect(dedupeFinds[0][1].expiresAt).toHaveProperty('$gt')
  })

  it('inserts a new invitation row when no pending invitation exists', async () => {
    ;(mockEm.findOne as jest.Mock).mockResolvedValue(null)

    const result = await service.createInvitation(
      'fresh@example.com',
      { tenantId, organizationId },
      { roleIds, invitedByUserId: 'inviter-2', displayName: 'Fresh' },
    )

    const invitationCreates = (mockEm.create as jest.Mock).mock.calls.filter(
      (call) => call[0] === CustomerUserInvitation,
    )
    expect(invitationCreates).toHaveLength(1)
    expect(invitationCreates[0][1]).toMatchObject({
      tenantId,
      organizationId,
      email: 'fresh@example.com',
      emailHash: 'email-hash',
      token: 'hashed-raw-token',
      roleIdsJson: roleIds,
    })
    expect(mockEm.persist).toHaveBeenCalled()
    expect(result.rawToken).toBe('raw-token')
    expect(result.reused).toBe(false)
    expect(result.rollbackSnapshot).toBeUndefined()
  })

  it('removes only the matching pending attempt for a freshly-created invitation', async () => {
    const invitation = {
      id: 'inv-fresh',
      tenantId,
      organizationId,
    } as unknown as CustomerUserInvitation

    await service.removeInvitation(invitation, 'hashed-raw-token')

    expect(mockEm.nativeDelete).toHaveBeenCalledWith(
      CustomerUserInvitation,
      expect.objectContaining({
        id: 'inv-fresh',
        tenantId,
        organizationId,
        token: 'hashed-raw-token',
        acceptedAt: null,
        cancelledAt: null,
      }),
    )
    expect(mockEm.flush).not.toHaveBeenCalled()
  })

  it('restores only the matching pending attempt from its rollback snapshot', async () => {
    const invitation = {
      id: 'inv-existing',
      tenantId,
      organizationId,
      email: 'new@example.com',
      token: 'new-hashed-token',
      customerEntityId: 'new-company',
      roleIdsJson: ['new-role'],
      invitedByUserId: 'new-inviter',
      invitedByCustomerUserId: null,
      displayName: 'New Name',
      expiresAt: new Date('2026-06-18T12:00:00.000Z'),
    } as unknown as CustomerUserInvitation

    await service.restoreInvitation(invitation, {
      email: 'old@example.com',
      emailHash: 'old-email-hash',
      token: 'old-hashed-token',
      customerEntityId: null,
      roleIdsJson: ['old-role'],
      invitedByUserId: 'old-inviter',
      invitedByCustomerUserId: 'old-portal-user',
      displayName: 'Old Name',
      expiresAt: new Date('2026-06-17T12:00:00.000Z'),
    }, 'new-hashed-token')

    expect(mockEm.nativeUpdate).toHaveBeenCalledWith(
      CustomerUserInvitation,
      expect.objectContaining({
        id: 'inv-existing',
        tenantId,
        organizationId,
        token: 'new-hashed-token',
        acceptedAt: null,
        cancelledAt: null,
      }),
      expect.objectContaining({
        email: 'old@example.com',
        emailHash: 'old-email-hash',
        token: 'old-hashed-token',
      }),
    )
    expect(invitation.email).toBe('old@example.com')
    expect(invitation.emailHash).toBe('old-email-hash')
    expect(invitation.token).toBe('old-hashed-token')
    expect(invitation.customerEntityId).toBeNull()
    expect(invitation.roleIdsJson).toEqual(['old-role'])
    expect(invitation.invitedByUserId).toBe('old-inviter')
    expect(invitation.invitedByCustomerUserId).toBe('old-portal-user')
    expect(invitation.displayName).toBe('Old Name')
    expect(invitation.expiresAt.toISOString()).toBe('2026-06-17T12:00:00.000Z')
    expect(mockEm.flush).not.toHaveBeenCalled()
  })

  it('fails a stale fresh-delete when another invite attempt already reused the row', async () => {
    ;(mockEm.nativeDelete as jest.Mock).mockResolvedValueOnce(0)
    const invitation = {
      id: 'inv-fresh',
      tenantId,
      organizationId,
    } as unknown as CustomerUserInvitation

    await expect(service.removeInvitation(invitation, 'stale-attempt-hash')).rejects.toThrow(
      'Invitation rollback delete did not affect exactly one pending invitation',
    )
  })

  it('fails a stale restore when another invite attempt already reused the row', async () => {
    ;(mockEm.nativeUpdate as jest.Mock).mockResolvedValueOnce(0)
    const invitation = {
      id: 'inv-existing',
      tenantId,
      organizationId,
    } as unknown as CustomerUserInvitation

    await expect(service.restoreInvitation(invitation, {
      email: 'old@example.com',
      emailHash: 'old-email-hash',
      token: 'old-hashed-token',
      expiresAt: new Date(Date.now() + 60_000),
    }, 'stale-attempt-hash')).rejects.toThrow(
      'Invitation rollback restore did not affect exactly one pending invitation',
    )
  })

  it('does not restore over an invitation accepted during rollback', async () => {
    ;(mockEm.nativeUpdate as jest.Mock).mockResolvedValueOnce(0)
    const invitation = {
      id: 'inv-existing',
      tenantId,
      organizationId,
      acceptedAt: new Date(),
    } as unknown as CustomerUserInvitation

    await expect(service.restoreInvitation(invitation, {
      email: 'old@example.com',
      emailHash: 'old-email-hash',
      token: 'old-hashed-token',
      expiresAt: new Date(Date.now() + 60_000),
    }, 'new-attempt-hash')).rejects.toThrow(
      'Invitation rollback restore did not affect exactly one pending invitation',
    )
  })

  it('can cancel only the current failed delivery attempt', async () => {
    const invitation = {
      id: 'inv-existing',
      tenantId,
      organizationId,
    } as unknown as CustomerUserInvitation

    await expect(service.cancelInvitationAttempt(invitation, 'current-attempt-hash')).resolves.toBe(true)

    expect(mockEm.nativeUpdate).toHaveBeenCalledWith(
      CustomerUserInvitation,
      expect.objectContaining({
        id: 'inv-existing',
        tenantId,
        organizationId,
        token: 'current-attempt-hash',
        acceptedAt: null,
        cancelledAt: null,
      }),
      expect.objectContaining({ cancelledAt: expect.any(Date) }),
    )
  })
})
