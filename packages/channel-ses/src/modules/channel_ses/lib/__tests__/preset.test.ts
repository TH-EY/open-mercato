import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import {
  applySesEnvPreset,
  assertSesEnvPresetAbsent,
  readSesEnvPreset,
  removeSesEnvPreset,
} from '../preset'

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: jest.fn(),
}))

const mockedFindOneWithDecryption = findOneWithDecryption as jest.MockedFunction<typeof findOneWithDecryption>

describe('channel_ses env preset', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      AWS_SES_REGION: 'eu-west-2',
      EMAIL_FROM: 'from@example.com',
    }
    mockedFindOneWithDecryption.mockReset()
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('creates a tenant-scoped credential row and system channel', async () => {
    mockedFindOneWithDecryption.mockResolvedValue(null)
    const channel = { id: 'channel-1' }
    const flush = jest.fn().mockResolvedValue(undefined)
    const persist = jest.fn().mockReturnValue({ flush })
    const em = { create: jest.fn().mockReturnValue(channel), persist }
    const save = jest.fn().mockResolvedValue(undefined)

    await applySesEnvPreset({
      em: em as never,
      container: { resolve: () => ({ save }) } as never,
      tenantId: 'tenant-1',
      organizationId: 'organization-1',
    })

    expect(save).toHaveBeenCalledWith(
      'channel_ses',
      { region: 'eu-west-2', fromAddress: 'from@example.com' },
      { tenantId: 'tenant-1', organizationId: 'organization-1', userId: null },
    )
    expect(em.create).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      tenantId: 'tenant-1',
      organizationId: 'organization-1',
      userId: null,
      providerKey: 'ses',
    }))
    expect(persist).toHaveBeenCalledWith(channel)
  })

  it('reactivates the exactly scoped existing system channel', async () => {
    const existing = { isActive: false, status: 'error', lastError: 'failed' }
    mockedFindOneWithDecryption.mockResolvedValue(existing as never)
    const flush = jest.fn().mockResolvedValue(undefined)
    const em = { flush }

    await applySesEnvPreset({
      em: em as never,
      container: { resolve: () => ({ save: jest.fn() }) } as never,
      tenantId: 'tenant-1',
      organizationId: 'organization-1',
    })

    expect(mockedFindOneWithDecryption).toHaveBeenCalledWith(
      em,
      expect.anything(),
      expect.objectContaining({ tenantId: 'tenant-1', organizationId: 'organization-1', userId: null }),
      undefined,
      { tenantId: 'tenant-1', organizationId: 'organization-1' },
    )
    expect(existing).toEqual(expect.objectContaining({ isActive: true, status: 'connected', lastError: null }))
    expect(flush).toHaveBeenCalledTimes(1)
  })

  it('requires an explicit region and sender address', () => {
    delete process.env.AWS_SES_REGION
    delete process.env.AWS_REGION
    expect(readSesEnvPreset()).toBeNull()
  })

  it('refuses rollback-unsafe replacement of existing provider state', async () => {
    const em = { findOne: jest.fn().mockResolvedValueOnce({ id: 'channel-1' }).mockResolvedValueOnce(null) }

    await expect(assertSesEnvPresetAbsent({
      em: em as never,
      container: {} as never,
      tenantId: 'tenant-1',
      organizationId: 'organization-1',
    })).rejects.toThrow('SES_ENV_PRESET_ALREADY_EXISTS')
  })

  it('removes only the exactly scoped SES channel and credentials', async () => {
    const nativeDelete = jest.fn().mockResolvedValue(1)
    const transactional = jest.fn(async (operation) => operation({ nativeDelete }))

    await removeSesEnvPreset({
      em: { transactional } as never,
      container: {} as never,
      tenantId: 'tenant-1',
      organizationId: 'organization-1',
    })

    expect(nativeDelete).toHaveBeenCalledTimes(2)
    expect(nativeDelete).toHaveBeenNthCalledWith(1, expect.anything(), expect.objectContaining({
      providerKey: 'ses',
      tenantId: 'tenant-1',
      organizationId: 'organization-1',
      userId: null,
    }))
    expect(nativeDelete).toHaveBeenNthCalledWith(2, expect.anything(), expect.objectContaining({
      integrationId: 'channel_ses',
      tenantId: 'tenant-1',
      organizationId: 'organization-1',
      userId: null,
    }))
  })
})
