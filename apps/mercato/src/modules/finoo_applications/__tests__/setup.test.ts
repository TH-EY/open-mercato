import { setup } from '../setup'

const tenantId = '11111111-1111-4111-8111-111111111111'
const organizationId = '22222222-2222-4222-8222-222222222222'

describe('FINOO application schedules', () => {
  beforeEach(() => {
    process.env.OM_FINOO_APPLICATION_TENANT_ID = tenantId
    process.env.OM_FINOO_APPLICATION_ORGANIZATION_ID = organizationId
  })

  it('registers only reconciliation for the configured FINOO scope', async () => {
    const register = jest.fn(async () => undefined)
    const container = {
      hasRegistration: (name: string) => name === 'schedulerService',
      resolve: () => ({ register }),
    }
    await setup.seedDefaults?.({ container, tenantId, organizationId } as never)
    expect(register).toHaveBeenCalledTimes(1)

    await setup.seedDefaults?.({
      container,
      tenantId,
      organizationId: '58f7401f-5e59-4ee3-8fbb-042d7c267517',
    } as never)
    expect(register).toHaveBeenCalledTimes(1)
  })
})
