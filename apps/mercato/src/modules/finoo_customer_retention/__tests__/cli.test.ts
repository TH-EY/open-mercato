import commands, {
  ensureFinooAdminCredential,
  ensureExistingOrganizationSetup,
  parseEnsureAdminCredentialArgs,
  parseEnsureOrganizationSetupArgs,
  parsePasswordFromStdin,
} from '../cli'

const tenantId = '11111111-1111-4111-8111-111111111111'
const organizationId = '22222222-2222-4222-8222-222222222222'
const userId = '33333333-3333-4333-8333-333333333333'

describe('finoo_customer_retention CLI', () => {
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

  it('registers only the targeted setup and credential commands', () => {
    expect(commands.map((command) => command.command)).toEqual([
      'ensure-organization-setup',
      'ensure-admin-credential',
    ])
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
    const em = {
      findOne: jest.fn()
        .mockResolvedValueOnce({ id: organizationId })
        .mockResolvedValueOnce({ id: 'settings-id' }),
    }
    const container = {
      resolve: jest.fn().mockReturnValue({ register }),
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
    const execute = jest.fn().mockResolvedValue({
      result: {
        id: userId,
        tenantId,
        organizationId,
        email: 'admin@finoo.om.they.dev',
        credential: 'updated',
      },
      logEntry: null,
    })
    const container = {} as never

    await expect(ensureFinooAdminCredential({
      container,
      commandBus: { execute } as never,
      tenantId,
      organizationId,
      userId,
      password: 'not-a-real-secret',
    })).resolves.toBe('updated')

    expect(execute).toHaveBeenCalledWith('finoo_customer_retention.admin.ensure_credential', {
      input: { tenantId, organizationId, userId, password: 'not-a-real-secret' },
      ctx: expect.objectContaining({ container, systemActor: true }),
      metadata: { skipLog: true },
    })
  })

  it('returns unchanged only for an exact no-op result', async () => {
    const execute = jest.fn().mockResolvedValue({
      result: {
        id: userId,
        tenantId,
        organizationId,
        email: 'admin@finoo.om.they.dev',
        credential: 'unchanged',
      },
      logEntry: null,
    })

    await expect(ensureFinooAdminCredential({
      container: {} as never,
      commandBus: { execute } as never,
      tenantId,
      organizationId,
      userId,
      password: 'not-a-real-secret',
    })).resolves.toBe('unchanged')
  })

  it('rejects a command result outside the exact requested scope', async () => {
    const execute = jest.fn().mockResolvedValue({
      result: {
        id: userId,
        tenantId,
        organizationId: '44444444-4444-4444-8444-444444444444',
        email: 'admin@finoo.om.they.dev',
        credential: 'updated',
      },
      logEntry: null,
    })
    await expect(ensureFinooAdminCredential({
      container: {} as never,
      commandBus: { execute } as never,
      tenantId,
      organizationId,
      userId,
      password: 'not-a-real-secret',
    })).rejects.toThrow('result scope mismatch')
  })
})
