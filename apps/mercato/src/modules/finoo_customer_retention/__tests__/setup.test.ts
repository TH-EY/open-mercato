import { FINOO_CUSTOMER_RETENTION_RECONCILE_QUEUE } from '../lib/constants'
import { finooCustomerRetentionScheduleId, setup } from '../setup'
import handleOrganizationCreated, {
  metadata as organizationCreatedMetadata,
} from '../subscribers/organization-created'

describe('finoo_customer_retention setup', () => {
  it('creates a deterministic organization-scoped hourly schedule', async () => {
    const register = jest.fn().mockResolvedValue(undefined)
    const em = {
      findOne: jest.fn().mockResolvedValue({ id: 'settings' }),
    }
    const container = {
      hasRegistration: jest.fn().mockReturnValue(true),
      resolve: jest.fn().mockReturnValue({ register }),
    }

    await setup.seedDefaults?.({
      em,
      container,
      tenantId: '11111111-1111-4111-8111-111111111111',
      organizationId: '22222222-2222-4222-8222-222222222222',
    } as never)

    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      id: finooCustomerRetentionScheduleId(
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
      ),
      scopeType: 'organization',
      scheduleType: 'interval',
      scheduleValue: '1h',
      timezone: 'UTC',
      targetQueue: FINOO_CUSTOMER_RETENTION_RECONCILE_QUEUE,
      targetPayload: {
        tenantId: '11111111-1111-4111-8111-111111111111',
        organizationId: '22222222-2222-4222-8222-222222222222',
      },
    }))
  })

  it('fails closed when the required scheduler service is unavailable', async () => {
    const persist = jest.fn()
    const flush = jest.fn().mockResolvedValue(undefined)
    const em = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((_entity, input) => input),
      persist,
      flush,
    }
    const container = { hasRegistration: jest.fn().mockReturnValue(false) }

    await expect(setup.seedDefaults?.({
      em,
      container,
      tenantId: 'tenant-id',
      organizationId: 'organization-id',
    } as never)).rejects.toThrow('requires schedulerService')

    expect(persist).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-id',
      organizationId: 'organization-id',
      inactivityWindowDays: null,
      reconciliationGeneration: 0,
    }))
    expect(flush).toHaveBeenCalledTimes(1)
  })

  it('initializes settings and the hourly schedule for a newly created organization', async () => {
    const persist = jest.fn()
    const flush = jest.fn().mockResolvedValue(undefined)
    const register = jest.fn().mockResolvedValue(undefined)
    const em = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((_entity, input) => input),
      persist,
      flush,
    }
    const container = {
      resolve: jest.fn((name: string) => name === 'em'
        ? { fork: () => em }
        : { register }),
      hasRegistration: jest.fn().mockReturnValue(true),
    }

    await handleOrganizationCreated({
      id: '22222222-2222-4222-8222-222222222222',
      tenantId: '11111111-1111-4111-8111-111111111111',
    }, container)

    expect(organizationCreatedMetadata).toEqual(expect.objectContaining({
      event: 'directory.organization.created',
      persistent: true,
    }))
    expect(persist).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: '22222222-2222-4222-8222-222222222222',
      inactivityWindowDays: null,
    }))
    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: '22222222-2222-4222-8222-222222222222',
      scheduleValue: '1h',
    }))
  })

  it('repairs a removed schedule by re-registering the deterministic definition', async () => {
    const register = jest.fn().mockResolvedValue(undefined)
    const em = { findOne: jest.fn().mockResolvedValue({ id: 'settings' }) }
    const container = {
      hasRegistration: jest.fn().mockReturnValue(true),
      resolve: jest.fn().mockReturnValue({ register }),
    }
    const setupInput = {
      em,
      container,
      tenantId: '11111111-1111-4111-8111-111111111111',
      organizationId: '22222222-2222-4222-8222-222222222222',
    } as never

    await setup.seedDefaults?.(setupInput)
    await setup.seedDefaults?.(setupInput)

    expect(register).toHaveBeenCalledTimes(2)
    expect(register.mock.calls[0]?.[0].id).toBe(register.mock.calls[1]?.[0].id)
  })
})
