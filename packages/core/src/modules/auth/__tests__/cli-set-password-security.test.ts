/** @jest-environment node */
jest.mock('@open-mercato/shared/lib/encryption/toggles', () => ({
  isTenantDataEncryptionEnabled: () => false,
  isEncryptionDebugEnabled: () => false,
}))

import cli from '@open-mercato/core/modules/auth/cli'

const user = {
  id: '00000000-0000-4000-8000-000000000001',
  tenantId: '00000000-0000-4000-8000-000000000002',
  email: 'admin@example.com',
  passwordHash: 'old-hash',
}
const findOne = jest.fn(async () => user)
const find = jest.fn(async () => [user])
const nativeUpdate = jest.fn(async (..._args: any[]) => 1)
const nativeDelete = jest.fn(async (..._args: any[]) => 1)
const transactional = jest.fn(async (callback: (em: any) => Promise<void>) => {
  await callback({ nativeUpdate, nativeDelete })
})

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: async () => ({
    resolve: () => ({ findOne, find, transactional }),
  }),
}))

const setPasswordCommand = cli.find((command: any) => command.command === 'set-password')!
const ENV_NAME = 'OM_TEST_ROTATED_ADMIN_PASSWORD'
const ROTATED_PASSWORD = 'Rotated-Manoj-2026!xQ7'
const scopedArgs = [
  '--email',
  user.email,
  '--user-id',
  user.id,
  '--tenant-id',
  user.tenantId,
  '--password-env',
  ENV_NAME,
]

describe('mercato auth set-password secret input', () => {
  let logSpy: jest.SpyInstance

  beforeEach(() => {
    jest.clearAllMocks()
    user.passwordHash = 'old-hash'
    process.env[ENV_NAME] = ROTATED_PASSWORD
    findOne.mockResolvedValue(user)
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  afterEach(() => {
    delete process.env[ENV_NAME]
    logSpy.mockRestore()
  })

  it('updates the password from an environment variable without logging it', async () => {
    await setPasswordCommand.run(scopedArgs)

    const bcrypt = await import('bcryptjs')
    const updatedPasswordHash = nativeUpdate.mock.calls[0]?.[2]?.passwordHash
    expect(await bcrypt.compare(ROTATED_PASSWORD, updatedPasswordHash)).toBe(true)
    expect(logSpy.mock.calls.flat().join(' ')).not.toContain(ROTATED_PASSWORD)
    expect(nativeDelete).toHaveBeenCalledTimes(2)
    expect(nativeDelete.mock.calls.map((call) => call[0].name)).toEqual(['Session', 'PasswordReset'])
    expect(nativeUpdate.mock.calls[0]?.[1]).toMatchObject({ id: user.id, tenantId: user.tenantId })
    expect(transactional).toHaveBeenCalledTimes(1)
  })

  it('fails when the named password environment variable is missing', async () => {
    delete process.env[ENV_NAME]

    await expect(
      setPasswordCommand.run(scopedArgs),
    ).rejects.toThrow('Usage: mercato auth set-password')
  })

  it('fails when the target user does not exist', async () => {
    findOne.mockResolvedValueOnce(null)

    await expect(
      setPasswordCommand.run(scopedArgs),
    ).rejects.toThrow('not found')
  })

  it('preserves the legacy email form when it resolves exactly one active user', async () => {
    await setPasswordCommand.run(['--email', user.email, '--password-env', ENV_NAME])

    expect(nativeUpdate).toHaveBeenCalled()
  })

  it('fails closed when the legacy email form is ambiguous', async () => {
    find.mockResolvedValueOnce([user, { ...user, id: '00000000-0000-4000-8000-000000000003' }])

    await expect(
      setPasswordCommand.run(['--email', user.email, '--password-env', ENV_NAME]),
    ).rejects.toThrow('Multiple active users')
  })
})
