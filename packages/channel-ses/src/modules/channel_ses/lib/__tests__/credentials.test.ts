import { resolveSesClientCredentials, sesCredentialsSchema } from '../credentials'

describe('channel_ses credentials', () => {
  const publicCredentials = { region: 'eu-west-2', fromAddress: 'from@example.com' }

  it('preserves the existing AWS SDK default credential chain behavior', () => {
    const parsed = sesCredentialsSchema.parse({ ...publicCredentials, legacyOperatorNote: 'preserved compatibility' })
    expect(resolveSesClientCredentials(parsed)).toBeUndefined()
  })

  it('returns a complete explicit credential pair only in access-key mode', () => {
    const parsed = sesCredentialsSchema.parse({
      ...publicCredentials,
      authMode: 'access_keys',
      accessKeyId: 'access-key-id',
      secretAccessKey: 'secret-access-key',
    })
    expect(resolveSesClientCredentials(parsed)).toEqual({
      accessKeyId: 'access-key-id',
      secretAccessKey: 'secret-access-key',
    })
  })

  it.each([
    { ...publicCredentials, authMode: 'access_keys' },
    { ...publicCredentials, authMode: 'access_keys', accessKeyId: 'access-key-id' },
    { ...publicCredentials, authMode: 'ambient', accessKeyId: 'access-key-id', secretAccessKey: 'secret-access-key' },
    { ...publicCredentials, accessKeyId: 'access-key-id', secretAccessKey: 'secret-access-key' },
  ])('rejects incomplete or non-opt-in explicit credentials', (credentials) => {
    expect(sesCredentialsSchema.safeParse(credentials).success).toBe(false)
  })
})
