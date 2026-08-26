import { Role, RoleAcl, UserRole } from '@open-mercato/core/modules/auth/data/entities'
import { Organization, Tenant } from '@open-mercato/core/modules/directory/data/entities'
import { ensureCustomRoleAcls, ensureRoles } from '@open-mercato/core/modules/auth/lib/setup-app'
import { LockMode } from '@mikro-orm/postgresql'
import commands, {
  ensureExistingOrganizationSetup,
  parseEnsureOrganizationSetupArgs,
} from '../cli'
import { FINOO_IOD_ROLE, FINOO_SUPERADMIN_ROLE } from '../setup'

jest.mock('@open-mercato/core/modules/auth/lib/setup-app', () => ({
  ensureRoles: jest.fn().mockResolvedValue(undefined),
  ensureCustomRoleAcls: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: (em: { findOne: (...args: unknown[]) => unknown }, Entity: unknown, where: unknown) => (
    em.findOne(Entity, where)
  ),
  findWithDecryption: (em: { find: (...args: unknown[]) => unknown }, Entity: unknown, where: unknown, options: unknown) => (
    em.find(Entity, where, options)
  ),
}))

const tenantId = '5164d495-1865-4738-b459-2783999a761d'
const organizationId = 'd0d98cb3-28cf-4376-a61c-d270020f166f'
const expectedFeatures = [
  'customers.people.view',
  'finoo_identities.view',
  'finoo_identities.manage',
]

function createEntityManager(options: {
  tenant?: object | null
  organization?: object | null
  assignments?: number[]
  activeAcls?: Array<Record<string, unknown>>
  finooSuperadminRoles?: Array<Record<string, unknown>>
  finooSuperadminAcls?: Array<Record<string, unknown>>
  finooSuperadminAssignments?: number[]
} = {}) {
  const role = { id: 'iod-role', name: FINOO_IOD_ROLE, tenantId }
  const finooSuperadminRole = { id: 'finoo-superadmin-role', name: FINOO_SUPERADMIN_ROLE, tenantId }
  const activeAcls = options.activeAcls ?? [{
    id: 'iod-acl',
    role,
    tenantId,
    featuresJson: ['unexpected.permission'],
    isSuperAdmin: true,
    organizationsJson: null,
  }]
  const finooSuperadminRoles = options.finooSuperadminRoles ?? [finooSuperadminRole]
  const finooSuperadminAcls = options.finooSuperadminAcls ?? [{
    id: 'finoo-superadmin-acl',
    role: finooSuperadminRole,
    tenantId,
    featuresJson: ['customers.*', 'auth.*'],
    isSuperAdmin: false,
    organizationsJson: [organizationId],
  }]
  const assignments = [...(options.assignments ?? [0, 0])]
  const finooSuperadminAssignments = [...(options.finooSuperadminAssignments ?? [3, 3])]
  const findOne = jest.fn(async (Entity: unknown, where?: { name?: string; role?: { id?: string } }) => {
    if (Entity === Tenant) return options.tenant === undefined ? { id: tenantId } : options.tenant
    if (Entity === Organization) {
      return options.organization === undefined ? { id: organizationId } : options.organization
    }
    if (Entity === Role) return where?.name === FINOO_SUPERADMIN_ROLE ? finooSuperadminRoles[0] ?? null : role
    if (Entity === RoleAcl) return activeAcls[0] ?? null
    return null
  })
  const find = jest.fn(async (
    Entity: unknown,
    where?: { name?: string; role?: { id?: string } },
    _options?: { lockMode?: LockMode },
  ) => {
    if (Entity === Role) return where?.name === FINOO_SUPERADMIN_ROLE ? finooSuperadminRoles : [role]
    if (Entity === RoleAcl) {
      return where?.role?.id === finooSuperadminRole.id ? finooSuperadminAcls : activeAcls
    }
    return []
  })
  const count = jest.fn(async (Entity: unknown, where?: { role?: { id?: string } }) => {
    if (Entity !== UserRole) return 0
    return where?.role?.id === finooSuperadminRole.id
      ? finooSuperadminAssignments.shift() ?? 0
      : assignments.shift() ?? 0
  })
  const flush = jest.fn().mockResolvedValue(undefined)
  const persist = jest.fn(() => ({ flush }))
  const invalidateTenantCache = jest.fn().mockResolvedValue(undefined)
  const container = { resolve: jest.fn(() => ({ invalidateTenantCache })) }
  const transactional = jest.fn(async (callback: (transactionalEm: unknown) => unknown) => callback({
    findOne,
    find,
    count,
    persist,
  }))
  return {
    em: { transactional },
    container,
    role,
    activeAcls,
    finooSuperadminRole,
    finooSuperadminAcls,
    findOne,
    find,
    count,
    persist,
    flush,
    invalidateTenantCache,
  }
}

describe('FINOO identity existing-organization setup CLI', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('accepts only one exact UUID scope with explicit apply', () => {
    expect(parseEnsureOrganizationSetupArgs([
      '--tenant', tenantId,
      '--organization', organizationId,
      '--apply',
    ])).toEqual({ tenantId, organizationId })
    expect(parseEnsureOrganizationSetupArgs([
      '--tenant', tenantId,
      '--organization', organizationId,
    ])).toBeNull()
    expect(parseEnsureOrganizationSetupArgs([
      '--tenant', tenantId,
      '--organization', organizationId,
      '--apply',
      '--force',
    ])).toBeNull()
  })

  it('registers setup without exposing a permanent-purge shortcut', () => {
    expect(commands.map((command) => command.command)).toEqual([
      'ensure-organization-setup',
      'migrate-legacy',
      'verify-legacy',
      'cutover-legacy',
      'rollback-legacy',
      'purge-legacy',
      'repair-completeness',
    ])
  })

  it('seeds the IOD role and replaces its ACL with the exact module contract', async () => {
    const state = createEntityManager({ assignments: [2, 2] })

    const result = await ensureExistingOrganizationSetup({
      em: state.em,
      container: state.container,
      tenantId,
      organizationId,
    } as never)

    expect(state.findOne).toHaveBeenCalledWith(Tenant, { id: tenantId, deletedAt: null })
    expect(state.findOne).toHaveBeenCalledWith(Organization, {
      id: organizationId,
      tenant: tenantId,
      deletedAt: null,
    })
    expect(state.find).toHaveBeenCalledWith(Role, {
      name: FINOO_SUPERADMIN_ROLE,
      tenantId,
      deletedAt: null,
    }, { lockMode: LockMode.PESSIMISTIC_WRITE })
    expect(state.find).toHaveBeenCalledWith(RoleAcl, {
      role: state.finooSuperadminRole,
      tenantId,
      deletedAt: null,
    }, { lockMode: LockMode.PESSIMISTIC_WRITE })
    expect(ensureRoles).toHaveBeenCalledWith(expect.anything(), {
      tenantId,
      roleNames: [FINOO_IOD_ROLE],
    })
    expect(ensureCustomRoleAcls).toHaveBeenCalledWith(
      expect.anything(),
      tenantId,
      [expect.objectContaining({ id: 'finoo_identities' })],
    )
    expect(state.activeAcls[0]).toMatchObject({
      featuresJson: expectedFeatures,
      isSuperAdmin: false,
      organizationsJson: [organizationId],
    })
    expect(state.finooSuperadminAcls[0]).toMatchObject({
      featuresJson: ['customers.*', 'auth.*', 'finoo_identities.*'],
      isSuperAdmin: false,
      organizationsJson: [organizationId],
    })
    expect(state.invalidateTenantCache).toHaveBeenCalledWith(tenantId)
    expect(result).toEqual({
      iodFeatures: expectedFeatures,
      assignedUsers: 2,
      automaticUserAssignments: 0,
      finooSuperadminFeatures: ['finoo_identities.*'],
      finooSuperadminAssignedUsers: 3,
    })
  })

  it.each([
    ['tenant', { tenant: null }],
    ['organization', { organization: null }],
  ])('rejects an invalid exact %s scope before role setup', async (_label, options) => {
    const state = createEntityManager(options)

    await expect(ensureExistingOrganizationSetup({
      em: state.em,
      container: state.container,
      tenantId,
      organizationId,
    } as never)).rejects.toThrow(/does not exist/)

    expect(ensureRoles).not.toHaveBeenCalled()
    expect(ensureCustomRoleAcls).not.toHaveBeenCalled()
  })

  it('fails closed if setup changes IOD user assignments', async () => {
    const state = createEntityManager({ assignments: [0, 1] })

    await expect(ensureExistingOrganizationSetup({
      em: state.em,
      container: state.container,
      tenantId,
      organizationId,
    } as never)).rejects.toThrow('must not assign users automatically')
  })

  it('fails closed when the IOD role has an ambiguous active ACL', async () => {
    const state = createEntityManager({
      activeAcls: [
        { id: 'acl-1' },
        { id: 'acl-2' },
      ],
    })

    await expect(ensureExistingOrganizationSetup({
      em: state.em,
      container: state.container,
      tenantId,
      organizationId,
    } as never)).rejects.toThrow('exactly one active ACL')
  })

  it.each([
    ['missing role', { finooSuperadminRoles: [] }, 'must exist exactly once'],
    ['duplicate role', { finooSuperadminRoles: [{ id: 'role-a' }, { id: 'role-b' }] }, 'must exist exactly once'],
    ['missing ACL', { finooSuperadminAcls: [] }, 'must have exactly one active ACL'],
    ['duplicate ACL', { finooSuperadminAcls: [{ id: 'acl-a' }, { id: 'acl-b' }] }, 'must have exactly one active ACL'],
  ])('fails closed for FINOO Superadmin %s', async (_label, options, message) => {
    const state = createEntityManager(options)

    await expect(ensureExistingOrganizationSetup({
      em: state.em,
      container: state.container,
      tenantId,
      organizationId,
    } as never)).rejects.toThrow(message)

    expect(ensureRoles).not.toHaveBeenCalled()
    expect(state.invalidateTenantCache).not.toHaveBeenCalled()
  })

  it.each([
    ['unrestricted organization scope', { organizationsJson: null, isSuperAdmin: false }],
    ['platform-superadmin flag', { organizationsJson: [organizationId], isSuperAdmin: true }],
  ])('fails closed for FINOO Superadmin %s', async (_label, acl) => {
    const state = createEntityManager({
      finooSuperadminAcls: [{
        id: 'finoo-superadmin-acl',
        role: { id: 'finoo-superadmin-role' },
        tenantId,
        featuresJson: ['customers.*'],
        ...acl,
      }],
    })

    await expect(ensureExistingOrganizationSetup({
      em: state.em,
      container: state.container,
      tenantId,
      organizationId,
    } as never)).rejects.toThrow('not restricted to the requested organization')

    expect(ensureRoles).not.toHaveBeenCalled()
    expect(state.invalidateTenantCache).not.toHaveBeenCalled()
  })

  it('fails closed when FINOO Superadmin features are malformed', async () => {
    const state = createEntityManager({
      finooSuperadminAcls: [{
        id: 'finoo-superadmin-acl',
        role: { id: 'finoo-superadmin-role' },
        tenantId,
        featuresJson: null,
        isSuperAdmin: false,
        organizationsJson: [organizationId],
      }],
    })

    await expect(ensureExistingOrganizationSetup({
      em: state.em,
      container: state.container,
      tenantId,
      organizationId,
    } as never)).rejects.toThrow('features must be an array')

    expect(ensureRoles).not.toHaveBeenCalled()
    expect(state.invalidateTenantCache).not.toHaveBeenCalled()
  })
})
