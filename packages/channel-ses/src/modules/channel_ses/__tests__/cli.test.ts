import { readFileSync } from 'node:fs'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import commands from '../cli'
import { configureSesExplicitCredentials } from '../lib/preset'

jest.mock('node:fs', () => ({ readFileSync: jest.fn() }))
jest.mock('@open-mercato/shared/lib/di/container', () => ({ createRequestContainer: jest.fn() }))
jest.mock('../lib/preset', () => ({
  assertSesEnvPresetAbsent: jest.fn(),
  assertSesEnvPresetExact: jest.fn(),
  assertSesExplicitCredentialsExact: jest.fn(),
  assertSesExplicitCredentialsHealthy: jest.fn(),
  configureSesExplicitCredentials: jest.fn(),
  removeSesEnvPreset: jest.fn(),
  restoreSesAmbientCredentials: jest.fn(),
}))

const mockedReadFileSync = readFileSync as jest.MockedFunction<typeof readFileSync>
const mockedCreateRequestContainer = createRequestContainer as jest.MockedFunction<typeof createRequestContainer>
const mockedConfigure = configureSesExplicitCredentials as jest.MockedFunction<typeof configureSesExplicitCredentials>

describe('channel_ses CLI', () => {
  it('reads the dedicated pair from stdin and never prints either value', async () => {
    const explicitCredentials = {
      accessKeyId: 'access-key-id',
      secretAccessKey: 'secret-access-key',
    }
    mockedReadFileSync.mockReturnValue(JSON.stringify(explicitCredentials))
    const em = {
      findOne: jest.fn().mockResolvedValue({ tenant: { id: 'tenant-1' } }),
    }
    const dispose = jest.fn()
    mockedCreateRequestContainer.mockResolvedValue({
      resolve: (name: string) => {
        if (name === 'em') return { fork: () => em }
        throw new Error(`[internal] Unexpected dependency: ${name}`)
      },
      dispose,
    } as never)
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined)
    const command = commands.find((entry) => entry.command === 'configure-explicit-credentials')

    await command?.run(['--tenant', 'tenant-1', '--organization', 'organization-1'])

    expect(mockedReadFileSync).toHaveBeenCalledWith(0, 'utf8')
    expect(mockedConfigure).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-1',
      organizationId: 'organization-1',
    }), explicitCredentials)
    expect(log.mock.calls.flat().join(' ')).not.toContain(explicitCredentials.accessKeyId)
    expect(log.mock.calls.flat().join(' ')).not.toContain(explicitCredentials.secretAccessKey)
    expect(dispose).toHaveBeenCalledTimes(1)
    log.mockRestore()
  })

  it('redacts malformed stdin from the propagated error', async () => {
    const sentinel = 'VISIBLE-SECRET-SENTINEL'
    mockedReadFileSync.mockReturnValue(`{"accessKeyId":"id","secretAccessKey":${sentinel}`)
    const command = commands.find((entry) => entry.command === 'configure-explicit-credentials')

    await expect(command?.run(['--tenant', 'tenant-1', '--organization', 'organization-1']))
      .rejects.toThrow('Invalid Amazon SES dedicated credential input')
    await expect(command?.run(['--tenant', 'tenant-1', '--organization', 'organization-1']))
      .rejects.not.toThrow(sentinel)
  })
})
