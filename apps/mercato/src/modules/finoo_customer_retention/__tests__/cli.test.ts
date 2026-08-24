import commands, { parseEnsureOrganizationSetupArgs } from '../cli'

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
})
