import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { GET, metadata, PUT } from '../route'

const getAuthFromRequest = jest.fn()
const createRequestContainer = jest.fn()
const resolveOrganizationScopeForRequest = jest.fn()
const runRouteMutationGuards = jest.fn()

jest.mock('@open-mercato/shared/lib/auth/server', () => ({
  getAuthFromRequest: (...args: unknown[]) => getAuthFromRequest(...args),
}))

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: (...args: unknown[]) => createRequestContainer(...args),
}))

jest.mock('@open-mercato/core/modules/directory/utils/organizationScope', () => ({
  resolveOrganizationScopeForRequest: (...args: unknown[]) => resolveOrganizationScopeForRequest(...args),
}))

jest.mock('@open-mercato/shared/lib/crud/route-mutation-guard', () => ({
  runRouteMutationGuards: (...args: unknown[]) => runRouteMutationGuards(...args),
}))

describe('FINOO identity person route', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    getAuthFromRequest.mockResolvedValue({
      sub: '54af32b0-9209-48b2-a78d-13d2602ea741',
      tenantId: '5164d495-1865-4738-b459-2783999a761d',
      orgId: 'd0d98cb3-28cf-4376-a61c-d270020f166f',
    })
    resolveOrganizationScopeForRequest.mockResolvedValue({
      selectedId: 'd0d98cb3-28cf-4376-a61c-d270020f166f',
    })
    runRouteMutationGuards.mockResolvedValue({
      ok: true,
      modifiedPayload: null,
      runAfterSuccess: jest.fn(async () => undefined),
    })
  })

  it('delegates denied reads to the audited service and returns its stable 403', async () => {
    const readForAuthorizedActor = jest.fn(async () => {
      throw new CrudHttpError(403, { error: 'identity_access_denied' })
    })
    createRequestContainer.mockResolvedValue({
      resolve: (key: string) => {
        if (key === 'finooIdentityService') return { readForAuthorizedActor }
        throw new Error(`Unexpected dependency: ${key}`)
      },
    })

    const response = await GET(
      new Request('http://localhost/api/finoo_identities/people/ee823a18-e50c-4de4-9d71-4f516d7d754e'),
      { params: Promise.resolve({ personId: 'ee823a18-e50c-4de4-9d71-4f516d7d754e' }) },
    )

    expect(metadata.GET).toEqual({ requireAuth: true })
    expect(response.status).toBe(403)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(await response.json()).toEqual({ error: 'identity_access_denied' })
    expect(readForAuthorizedActor).toHaveBeenCalledWith({
      actorUserId: '54af32b0-9209-48b2-a78d-13d2602ea741',
      tenantId: '5164d495-1865-4738-b459-2783999a761d',
      organizationId: 'd0d98cb3-28cf-4376-a61c-d270020f166f',
      personId: 'ee823a18-e50c-4de4-9d71-4f516d7d754e',
    })
  })

  it('runs mutation guards and returns no raw values after an authorized write', async () => {
    const authorizeIdentityManagementActor = jest.fn(async () => undefined)
    const upsertForAuthorizedActor = jest.fn(async () => ({
      id: '4e5f6a45-e7fd-40df-85b5-ad8a6e82d5b5',
      isComplete: true,
      statuses: {
        pesel: 'complete',
        documentType: 'complete',
        issuingCountryCode: 'complete',
        documentNumber: 'complete',
        issuedOn: 'complete',
        expiresOn: 'complete',
      },
      updatedAt: '2026-08-24T14:00:00.000Z',
    }))
    createRequestContainer.mockResolvedValue({
      resolve: (key: string) => {
        if (key === 'finooIdentityService') return { authorizeIdentityManagementActor, upsertForAuthorizedActor }
        throw new Error(`Unexpected dependency: ${key}`)
      },
    })
    const request = new Request(
      'http://localhost/api/finoo_identities/people/ee823a18-e50c-4de4-9d71-4f516d7d754e',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          pesel: '44051401458',
          documentType: 'identity_card',
          issuingCountryCode: 'PL',
          documentNumber: 'ABC123456',
          issuedOn: '2024-01-10',
          expiresOn: '2034-01-10',
        }),
      },
    )

    const response = await PUT(request, {
      params: Promise.resolve({ personId: 'ee823a18-e50c-4de4-9d71-4f516d7d754e' }),
    })

    expect(metadata.PUT).toEqual({ requireAuth: true })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    const body = await response.json()
    expect(body).toMatchObject({ id: '4e5f6a45-e7fd-40df-85b5-ad8a6e82d5b5', isComplete: true })
    expect(JSON.stringify(body)).not.toContain('44051401458')
    expect(authorizeIdentityManagementActor).toHaveBeenCalledWith({
      actorUserId: '54af32b0-9209-48b2-a78d-13d2602ea741',
      tenantId: '5164d495-1865-4738-b459-2783999a761d',
      organizationId: 'd0d98cb3-28cf-4376-a61c-d270020f166f',
      personId: 'ee823a18-e50c-4de4-9d71-4f516d7d754e',
    })
    expect(authorizeIdentityManagementActor.mock.invocationCallOrder[0]).toBeLessThan(
      runRouteMutationGuards.mock.invocationCallOrder[0],
    )
    expect(runRouteMutationGuards).toHaveBeenCalledTimes(1)
    expect(runRouteMutationGuards).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({
        mutationPayload: { changedFields: ['pesel', 'documentType', 'issuingCountryCode', 'documentNumber', 'issuedOn', 'expiresOn'] },
      }),
    }))
    expect(JSON.stringify(runRouteMutationGuards.mock.calls[0])).not.toContain('44051401458')
    expect(upsertForAuthorizedActor).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({ pesel: '44051401458' }),
      request,
    }))
  })

  it('returns an audited authorization denial before exposing input to mutation guards', async () => {
    const authorizeIdentityManagementActor = jest.fn(async () => {
      throw new CrudHttpError(403, { error: 'identity_access_denied' })
    })
    const upsertForAuthorizedActor = jest.fn()
    createRequestContainer.mockResolvedValue({
      resolve: (key: string) => key === 'finooIdentityService'
        ? { authorizeIdentityManagementActor, upsertForAuthorizedActor }
        : (() => { throw new Error(`Unexpected dependency: ${key}`) })(),
    })
    const request = new Request(
      'http://localhost/api/finoo_identities/people/ee823a18-e50c-4de4-9d71-4f516d7d754e',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          pesel: '44051401458',
          documentType: 'identity_card',
          issuingCountryCode: 'PL',
          documentNumber: 'ABC123456',
          issuedOn: '2024-01-10',
          expiresOn: '2034-01-10',
        }),
      },
    )

    const response = await PUT(request, {
      params: Promise.resolve({ personId: 'ee823a18-e50c-4de4-9d71-4f516d7d754e' }),
    })

    expect(response.status).toBe(403)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(await response.json()).toEqual({ error: 'identity_access_denied' })
    expect(request.bodyUsed).toBe(false)
    expect(runRouteMutationGuards).not.toHaveBeenCalled()
    expect(upsertForAuthorizedActor).not.toHaveBeenCalled()
  })
})
