/** @jest-environment node */
jest.mock('@open-mercato/shared/lib/encryption/toggles', () => ({
  isTenantDataEncryptionEnabled: () => false,
  isEncryptionDebugEnabled: () => false,
}))

import cli from '@open-mercato/core/modules/auth/cli'

const user = { email: 'admin@example.com', passwordHash: 'old-hash' }
const findOne = jest.fn(async () => user)
const flush = jest.fn(async () => {})
const persist = jest.fn(function persist(this: any) {
  return this
})

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: async () => ({
    resolve: () => ({ findOne, persist, flush }),
  }),
}))

const setPasswordCommand = cli.find((command: any) => command.command === 'set-password')!
const ENV_NAME = 'OM_TEST_ROTATED_ADMIN_PASSWORD'
const ROTATED_PASSWORD = 'Rotated-EPC-2026!xQ7'

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
    await setPasswordCommand.run([
      '--email',
      user.email,
      '--password-env',
      ENV_NAME,
    ])

    const bcrypt = await import('bcryptjs')
    expect(await bcrypt.compare(ROTATED_PASSWORD, user.passwordHash)).toBe(true)
    expect(logSpy.mock.calls.flat().join(' ')).not.toContain(ROTATED_PASSWORD)
    expect(flush).toHaveBeenCalled()
  })

  it('fails when the named password environment variable is missing', async () => {
    delete process.env[ENV_NAME]

    await expect(
      setPasswordCommand.run(['--email', user.email, '--password-env', ENV_NAME]),
    ).rejects.toThrow('Usage: mercato auth set-password')
  })

  it('fails when the target user does not exist', async () => {
    findOne.mockResolvedValueOnce(null)

    await expect(
      setPasswordCommand.run(['--email', user.email, '--password-env', ENV_NAME]),
    ).rejects.toThrow('not found')
  })
})
