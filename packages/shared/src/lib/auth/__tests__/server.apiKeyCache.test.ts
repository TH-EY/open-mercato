const verifyJwt = jest.fn(() => {
  throw new Error('no jwt')
})
const createRequestContainer = jest.fn()
const findApiKeyBySecret = jest.fn()
const emFind = jest.fn()
const emFindOne = jest.fn()
const emPersist = jest.fn()
const emFlush = jest.fn()

jest.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
}))

jest.mock('@open-mercato/shared/lib/auth/jwt', () => ({
  verifyJwt: (...args: unknown[]) => verifyJwt(...args),
}))

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: (...args: unknown[]) => createRequestContainer(...args),
}))

jest.mock('@open-mercato/core/modules/auth/lib/sessionIntegrity', () => ({
  resolveCanonicalStaffAuthContext: jest.fn(async (_em: unknown, auth: unknown) => auth),
}))

jest.mock('@open-mercato/core/modules/api_keys/services/apiKeyService', () => ({
  findApiKeyBySecret: (...args: unknown[]) => findApiKeyBySecret(...args),
}))

jest.mock('@open-mercato/core/modules/auth/data/entities', () => ({
  Role: class {},
  RoleAcl: class {},
  User: class {},
}))

jest.mock('@open-mercato/core/modules/directory/data/entities', () => ({
  Organization: class {},
  Tenant: class {},
}))

const em = {
  find: (...args: unknown[]) => emFind(...args),
  findOne: (...args: unknown[]) => emFindOne(...args),
  persist: (...args: unknown[]) => {
    emPersist(...args)
    return { flush: (...flushArgs: unknown[]) => emFlush(...flushArgs) }
  },
  flush: (...args: unknown[]) => emFlush(...args),
}

describe('resolveApiKeyAuth caching + lastUsedAt debounce', () => {
  beforeEach(async () => {
    jest.clearAllMocks()
    createRequestContainer.mockResolvedValue({
      resolve: (name: string) => (name === 'em' ? em : null),
    })
    emFind.mockResolvedValue([])
    emFindOne.mockResolvedValue(null)
    emPersist.mockReturnValue(undefined)
    emFlush.mockResolvedValue(undefined)
    const { resetSharedApiKeyAuthCacheForTests } = await import('@open-mercato/shared/lib/auth/apiKeyAuthCache')
    resetSharedApiKeyAuthCacheForTests()
  })

  function buildRequest(secret: string): Request {
    return new Request('https://example.test/api/test', {
      headers: { 'x-api-key': secret },
    })
  }

  it('serves repeated requests from cache without re-hitting findApiKeyBySecret', async () => {
    const { getAuthFromRequest } = await import('@open-mercato/shared/lib/auth/server')
    findApiKeyBySecret.mockResolvedValue({
      id: 'key-cache-1',
      name: 'cached',
      tenantId: null,
      organizationId: null,
      rolesJson: [],
      sessionUserId: null,
      createdBy: null,
      expiresAt: null,
      lastUsedAt: null,
    })

    const first = await getAuthFromRequest(buildRequest('cache-secret-1'))
    const second = await getAuthFromRequest(buildRequest('cache-secret-1'))
    const third = await getAuthFromRequest(buildRequest('cache-secret-1'))

    expect(first).toMatchObject({ isApiKey: true, keyId: 'key-cache-1' })
    expect(second).toEqual(first)
    expect(third).toEqual(first)
    expect(findApiKeyBySecret).toHaveBeenCalledTimes(1)
    expect(emFlush).toHaveBeenCalledTimes(1)
  })

  it('caches negative lookups so invalid keys skip the bcrypt+DB path', async () => {
    const { getAuthFromRequest } = await import('@open-mercato/shared/lib/auth/server')
    findApiKeyBySecret.mockResolvedValue(null)

    const first = await getAuthFromRequest(buildRequest('bad-secret'))
    const second = await getAuthFromRequest(buildRequest('bad-secret'))

    expect(first).toBeNull()
    expect(second).toBeNull()
    expect(findApiKeyBySecret).toHaveBeenCalledTimes(1)
  })

  it('invalidates cached entries once the API key is soft-deleted', async () => {
    const { getAuthFromRequest } = await import('@open-mercato/shared/lib/auth/server')
    const { getSharedApiKeyAuthCache } = await import('@open-mercato/shared/lib/auth/apiKeyAuthCache')
    findApiKeyBySecret.mockResolvedValue({
      id: 'key-invalidate',
      name: 'cached',
      tenantId: null,
      organizationId: null,
      rolesJson: [],
      sessionUserId: null,
      createdBy: null,
      expiresAt: null,
      lastUsedAt: null,
    })

    await getAuthFromRequest(buildRequest('secret-invalidate'))
    expect(findApiKeyBySecret).toHaveBeenCalledTimes(1)

    getSharedApiKeyAuthCache().invalidateByKeyId('key-invalidate')
    await getAuthFromRequest(buildRequest('secret-invalidate'))
    expect(findApiKeyBySecret).toHaveBeenCalledTimes(2)
  })

  it('rejects org-scoped API keys when createdBy belongs to another organization', async () => {
    const { getAuthFromRequest } = await import('@open-mercato/shared/lib/auth/server')
    findApiKeyBySecret.mockResolvedValue({
      id: 'key-cross-org-user',
      name: 'cross-org-user',
      tenantId: 'tenant-1',
      organizationId: 'org-rule',
      rolesJson: ['role-1'],
      sessionUserId: null,
      createdBy: 'triggering-user',
      expiresAt: null,
      lastUsedAt: null,
    })
    emFind.mockResolvedValue([{ name: 'business_rules.view' }])
    emFindOne.mockImplementation(async (_Entity: unknown, where: any) => {
      if (where?.id === 'triggering-user') {
        return { id: 'triggering-user', tenantId: 'tenant-1', organizationId: 'org-trigger' }
      }
      return null
    })

    const auth = await getAuthFromRequest(buildRequest('secret-cross-org-user'))

    expect(auth).toBeNull()
  })

  it('authenticates org-scoped M2M API keys with createdBy null through tenant and organization scope', async () => {
    const { getAuthFromRequest } = await import('@open-mercato/shared/lib/auth/server')
    findApiKeyBySecret.mockResolvedValue({
      id: 'key-m2m',
      name: 'm2m',
      tenantId: 'tenant-1',
      organizationId: 'org-rule',
      rolesJson: ['role-1'],
      sessionUserId: null,
      createdBy: null,
      expiresAt: null,
      lastUsedAt: null,
    })
    emFind.mockResolvedValue([{ name: 'business_rules.view' }])
    emFindOne.mockImplementation(async (_Entity: unknown, where: any) => {
      if (where?.id === 'tenant-1' && where?.isActive === true) {
        return { id: 'tenant-1', isActive: true }
      }
      if (where?.id === 'org-rule' && where?.isActive === true) {
        return { id: 'org-rule', isActive: true, tenant: { id: 'tenant-1' } }
      }
      return null
    })

    const auth = await getAuthFromRequest(buildRequest('secret-m2m'))

    expect(auth).toMatchObject({
      sub: 'api_key:key-m2m',
      tenantId: 'tenant-1',
      orgId: 'org-rule',
      roles: ['business_rules.view'],
      isApiKey: true,
      keyId: 'key-m2m',
      keyName: 'm2m',
    })
    expect(auth).not.toHaveProperty('userId')
  })
})
