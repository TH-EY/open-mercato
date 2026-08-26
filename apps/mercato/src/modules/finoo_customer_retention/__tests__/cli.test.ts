import commands, {
  ensureFinooAdminCredential,
  ensureExistingOrganizationSetup,
  parseIdentityErasureArgs,
  parseEnsureAdminCredentialArgs,
  parseEnsureOrganizationSetupArgs,
  parsePasswordFromStdin,
} from '../cli'
import { ensureAdminCredentialCommand } from '../commands/admin-credential'
import { FINOO_CUSTOMER_RETENTION_FIELDS } from '../ce'

const tenantId = '11111111-1111-4111-8111-111111111111'
const organizationId = '22222222-2222-4222-8222-222222222222'
const userId = '33333333-3333-4333-8333-333333333333'

describe('finoo_customer_retention CLI', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('accepts one exact organization scope with explicit apply', () => {
    expect(parseEnsureOrganizationSetupArgs([
      '--tenant', tenantId,
      '--organization', organizationId,
      '--apply',
    ])).toEqual({ tenantId, organizationId })
  })

  it.each([
    ['missing apply', ['--tenant', tenantId, '--organization', organizationId]],
    ['invalid tenant', ['--tenant', 'invalid', '--organization', organizationId, '--apply']],
    ['unknown option', ['--tenant', tenantId, '--organization', organizationId, '--force']],
    ['duplicate scope', ['--tenant', tenantId, '--tenant', tenantId, '--apply']],
  ])('rejects %s', (_case, args) => {
    expect(parseEnsureOrganizationSetupArgs(args)).toBeNull()
  })

  it('registers only the targeted maintenance commands', () => {
    expect(commands.map((command) => command.command)).toEqual([
      'ensure-organization-setup',
      'ensure-admin-credential',
      'erase-expired-identities',
    ])
  })

  it('accepts a count-only identity erasure dry-run with a bounded batch', () => {
    expect(parseIdentityErasureArgs([
      '--tenant', tenantId,
      '--organization', organizationId,
      '--dry-run',
      '--batch-size', '25',
    ])).toEqual({ tenantId, organizationId, apply: false, batchSize: 25 })
  })

  it('accepts identity erasure apply only with the maintenance and task confirmations', () => {
    expect(parseIdentityErasureArgs([
      '--tenant', tenantId,
      '--organization', organizationId,
      '--apply',
      '--maintenance-window',
      '--confirm', 'THOM-108',
    ])).toEqual({ tenantId, organizationId, apply: true, batchSize: 100 })
  })

  it.each([
    ['both modes', ['--tenant', tenantId, '--organization', organizationId, '--dry-run', '--apply']],
    ['apply without maintenance', ['--tenant', tenantId, '--organization', organizationId, '--apply', '--confirm', 'THOM-108']],
    ['apply without confirmation', ['--tenant', tenantId, '--organization', organizationId, '--apply', '--maintenance-window']],
    ['wrong task confirmation', ['--tenant', tenantId, '--organization', organizationId, '--apply', '--maintenance-window', '--confirm', 'THOM-109']],
    ['dry-run with apply confirmation', ['--tenant', tenantId, '--organization', organizationId, '--dry-run', '--confirm', 'THOM-108']],
    ['unbounded batch', ['--tenant', tenantId, '--organization', organizationId, '--dry-run', '--batch-size', '501']],
    ['duplicate flag', ['--tenant', tenantId, '--organization', organizationId, '--dry-run', '--dry-run']],
    ['positional argument', ['--tenant', tenantId, '--organization', organizationId, '--dry-run', 'extra']],
  ])('rejects identity erasure arguments: %s', (_case, args) => {
    expect(parseIdentityErasureArgs(args)).toBeNull()
  })

  it('accepts only an exact admin scope with password stdin and explicit apply', () => {
    expect(parseEnsureAdminCredentialArgs([
      '--tenant', tenantId,
      '--organization', organizationId,
      '--user', userId,
      '--password-stdin',
      '--apply',
    ])).toEqual({ tenantId, organizationId, userId })
  })

  it.each([
    ['missing apply', ['--tenant', tenantId, '--organization', organizationId, '--user', userId, '--password-stdin']],
    ['missing stdin gate', ['--tenant', tenantId, '--organization', organizationId, '--user', userId, '--apply']],
    ['invalid user', ['--tenant', tenantId, '--organization', organizationId, '--user', 'invalid', '--password-stdin', '--apply']],
    ['duplicate user', ['--tenant', tenantId, '--organization', organizationId, '--user', userId, '--user', userId, '--apply']],
  ])('rejects admin credential args with %s', (_case, args) => {
    expect(parseEnsureAdminCredentialArgs(args)).toBeNull()
  })

  it('accepts one stdin line without trimming password characters', () => {
    expect(parsePasswordFromStdin(' password value \r\n')).toBe(' password value ')
  })

  it.each(['', '\n', 'first\nsecond\n'])('rejects invalid password stdin %j', (raw) => {
    expect(() => parsePasswordFromStdin(raw)).toThrow('exactly one non-empty line')
  })

  it('ensures settings and schedule only after the exact organization scope exists', async () => {
    const register = jest.fn().mockResolvedValue(undefined)
    const cache = { deleteByTags: jest.fn().mockResolvedValue(undefined) }
    const customFieldDefinitions = FINOO_CUSTOMER_RETENTION_FIELDS.map((field, priority) => {
      const { key, kind, ...configJson } = { ...field, priority }
      return {
        entityId: 'customers:customer_person_profile',
        tenantId,
        organizationId: null,
        key,
        kind,
        configJson,
        isActive: true,
        deletedAt: null,
      }
    })
    const em = {
      findOne: jest.fn()
        .mockResolvedValueOnce({ id: organizationId })
        .mockResolvedValueOnce({ id: 'settings-id' }),
      find: jest.fn().mockResolvedValue(customFieldDefinitions),
    }
    const container = {
      resolve: jest.fn((name: string) => (name === 'cache' ? cache : { register })),
      hasRegistration: jest.fn().mockReturnValue(true),
    }

    await ensureExistingOrganizationSetup({
      em,
      container,
      tenantId,
      organizationId,
    } as never)

    expect(em.findOne).toHaveBeenNthCalledWith(1, expect.any(Function), {
      id: organizationId,
      tenant: tenantId,
      deletedAt: null,
    })
    expect(register).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['nonexistent organization', null],
    ['organization from another tenant', null],
  ])('does not write setup state for %s', async (_case, organization) => {
    const persist = jest.fn()
    const flush = jest.fn()
    const register = jest.fn()
    const em = {
      findOne: jest.fn().mockResolvedValue(organization),
      create: jest.fn(),
      persist,
      flush,
    }
    const container = {
      resolve: jest.fn().mockReturnValue({ register }),
      hasRegistration: jest.fn().mockReturnValue(true),
    }

    await expect(ensureExistingOrganizationSetup({
      em,
      container,
      tenantId,
      organizationId,
    } as never)).rejects.toThrow('Organization does not exist in the requested tenant scope')

    expect(em.findOne).toHaveBeenCalledWith(expect.any(Function), {
      id: organizationId,
      tenant: tenantId,
      deletedAt: null,
    })
    expect(em.create).not.toHaveBeenCalled()
    expect(persist).not.toHaveBeenCalled()
    expect(flush).not.toHaveBeenCalled()
    expect(register).not.toHaveBeenCalled()
  })

  it('updates only the exact Finoo admin through the auth command', async () => {
    const execute = jest.spyOn(ensureAdminCredentialCommand, 'execute').mockResolvedValue({
      id: userId,
      tenantId,
      organizationId,
      email: 'admin@finoo.om.they.dev',
      credential: 'updated',
    })
    const container = {} as never

    await expect(ensureFinooAdminCredential({
      container,
      tenantId,
      organizationId,
      userId,
      password: 'not-a-real-secret',
    })).resolves.toBe('updated')

    expect(execute).toHaveBeenCalledWith(
      { tenantId, organizationId, userId, password: 'not-a-real-secret' },
      expect.objectContaining({ container, systemActor: true, auth: null }),
    )
  })

  it('returns unchanged only for an exact no-op result', async () => {
    jest.spyOn(ensureAdminCredentialCommand, 'execute').mockResolvedValue({
      id: userId,
      tenantId,
      organizationId,
      email: 'admin@finoo.om.they.dev',
      credential: 'unchanged',
    })

    await expect(ensureFinooAdminCredential({
      container: {} as never,
      tenantId,
      organizationId,
      userId,
      password: 'not-a-real-secret',
    })).resolves.toBe('unchanged')
  })

  it('rejects a command result outside the exact requested scope', async () => {
    jest.spyOn(ensureAdminCredentialCommand, 'execute').mockResolvedValue({
      id: userId,
      tenantId,
      organizationId: '44444444-4444-4444-8444-444444444444',
      email: 'admin@finoo.om.they.dev',
      credential: 'updated',
    })
    await expect(ensureFinooAdminCredential({
      container: {} as never,
      tenantId,
      organizationId,
      userId,
      password: 'not-a-real-secret',
    })).rejects.toThrow('result scope mismatch')
  })
})
