import commands, {
  ensureExistingOrganizationSetup,
  parseEnsureOrganizationSetupArgs,
} from '../cli'

const tenantId = '11111111-1111-4111-8111-111111111111'
const organizationId = '22222222-2222-4222-8222-222222222222'

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

  it('registers only the targeted setup command', () => {
    expect(commands.map((command) => command.command)).toEqual(['ensure-organization-setup'])
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
})
