import { LockMode } from '@mikro-orm/postgresql'
import { Session } from '@open-mercato/core/modules/auth/data/entities'
import { commandRegistry } from '@open-mercato/shared/lib/commands/registry'
import { hashSync } from 'bcryptjs'
import {
  ensureAdminCredentialCommand,
  persistExactFinooAdminCredential,
} from '../commands/admin-credential'

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: jest.fn((_em, _entity, where, options) => _em.findOne(_entity, where, options)),
}))

const tenantId = '11111111-1111-4111-8111-111111111111'
const organizationId = '22222222-2222-4222-8222-222222222222'
const userId = '33333333-3333-4333-8333-333333333333'

function buildEntityManager(user: Record<string, unknown> | null) {
  const transactionalEm = {
    findOne: jest.fn().mockResolvedValue(user),
    flush: jest.fn().mockResolvedValue(undefined),
    nativeDelete: jest.fn().mockResolvedValue(1),
  }
  return {
    transactionalEm,
    em: {
      transactional: jest.fn(async (callback) => callback(transactionalEm)),
    },
  }
}

describe('Finoo admin credential command', () => {
  it('is not registered for generic command-bus or notification dispatch', () => {
    expect(commandRegistry.has('finoo_customer_retention.admin.ensure_credential')).toBe(false)
  })

  it.each([
    ['authenticated caller', true, { sub: userId }],
    ['non-system caller', false, null],
  ])('rejects %s before resolving persistence dependencies', async (_case, systemActor, auth) => {
    const resolve = jest.fn()

    await expect(ensureAdminCredentialCommand.execute({
      tenantId,
      organizationId,
      userId,
      password: 'not-a-real-secret',
    }, {
      systemActor,
      auth,
      container: { resolve },
    } as never)).rejects.toThrow('requires a system actor')

    expect(resolve).not.toHaveBeenCalled()
  })

  it('locks and updates only the exact tenant, organization, user, and email', async () => {
    const user = {
      id: userId,
      tenantId,
      organizationId,
      email: 'admin@finoo.om.they.dev',
      passwordHash: null,
    }
    const { em, transactionalEm } = buildEntityManager(user)

    await expect(persistExactFinooAdminCredential({
      em: em as never,
      tenantId,
      organizationId,
      userId,
      password: 'not-a-real-secret',
    })).resolves.toEqual({
      id: userId,
      tenantId,
      organizationId,
      email: 'admin@finoo.om.they.dev',
      credential: 'updated',
    })

    expect(transactionalEm.findOne).toHaveBeenCalledWith(expect.any(Function), {
      id: userId,
      tenantId,
      organizationId,
      deletedAt: null,
    }, { lockMode: LockMode.PESSIMISTIC_WRITE })
    expect(user.passwordHash).not.toBeNull()
    expect(transactionalEm.flush).toHaveBeenCalledTimes(1)
    expect(transactionalEm.nativeDelete).toHaveBeenCalledWith(Session, { user: userId })
  })

  it('does not write or revoke sessions when the credential already matches', async () => {
    const { em, transactionalEm } = buildEntityManager({
      id: userId,
      tenantId,
      organizationId,
      email: 'admin@finoo.om.they.dev',
      passwordHash: hashSync('not-a-real-secret', 4),
    })

    await expect(persistExactFinooAdminCredential({
      em: em as never,
      tenantId,
      organizationId,
      userId,
      password: 'not-a-real-secret',
    })).resolves.toMatchObject({ credential: 'unchanged' })
    expect(transactionalEm.flush).not.toHaveBeenCalled()
    expect(transactionalEm.nativeDelete).not.toHaveBeenCalled()
  })

  it.each([
    ['missing exact row', null],
    ['wrong exact email', {
      id: userId,
      tenantId,
      organizationId,
      email: 'admin@example.com',
      passwordHash: null,
    }],
  ])('fails closed for %s', async (_case, user) => {
    const { em, transactionalEm } = buildEntityManager(user)
    await expect(persistExactFinooAdminCredential({
      em: em as never,
      tenantId,
      organizationId,
      userId,
      password: 'not-a-real-secret',
    })).rejects.toThrow('does not exist in the requested exact scope')
    expect(transactionalEm.flush).not.toHaveBeenCalled()
    expect(transactionalEm.nativeDelete).not.toHaveBeenCalled()
  })
})
