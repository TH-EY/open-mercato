import { GET } from '../route'
import { POST } from '../[id]/resolve/route'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'

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

describe('FINOO identity conflict routes', () => {
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

  it('lists conflicts for the requested scoped Person through the audited service', async () => {
    const listConflictsForAuthorizedActor = jest.fn(async () => ({ items: [], page: 1, pageSize: 50, total: 0 }))
    createRequestContainer.mockResolvedValue({
      resolve: (key: string) => key === 'finooIdentityService'
        ? { listConflictsForAuthorizedActor }
        : (() => { throw new Error(`Unexpected dependency: ${key}`) })(),
    })

    const response = await GET(new Request(
      'http://localhost/api/finoo_identities/import-conflicts?personId=ee823a18-e50c-4de4-9d71-4f516d7d754e&page=1&pageSize=50',
    ))

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(listConflictsForAuthorizedActor).toHaveBeenCalledWith({
      scope: {
        actorUserId: '54af32b0-9209-48b2-a78d-13d2602ea741',
        tenantId: '5164d495-1865-4738-b459-2783999a761d',
        organizationId: 'd0d98cb3-28cf-4376-a61c-d270020f166f',
        personId: 'ee823a18-e50c-4de4-9d71-4f516d7d754e',
      },
      page: 1,
      pageSize: 50,
    })
  })

  it('runs mutation guards before resolving a conflict and returns only safe metadata', async () => {
    const authorizeConflictManagementActor = jest.fn(async () => undefined)
    const resolveConflictForAuthorizedActor = jest.fn(async () => ({
      conflictId: '1dc885ce-a2ce-4053-a069-e27ae0942327',
      identityId: '4e5f6a45-e7fd-40df-85b5-ad8a6e82d5b5',
      state: 'resolved',
      isComplete: true,
      statuses: {
        pesel: 'complete',
        documentType: 'complete',
        issuingCountryCode: 'complete',
        documentNumber: 'complete',
        issuedOn: 'complete',
        expiresOn: 'complete',
      },
      identityUpdatedAt: '2026-08-24T14:10:00.000Z',
      conflictUpdatedAt: '2026-08-24T14:10:00.000Z',
    }))
    createRequestContainer.mockResolvedValue({
      resolve: (key: string) => key === 'finooIdentityService'
        ? { authorizeConflictManagementActor, resolveConflictForAuthorizedActor }
        : (() => { throw new Error(`Unexpected dependency: ${key}`) })(),
    })
    const body = {
      action: 'replace',
      updatedAt: '2026-08-24T14:05:00.000Z',
      identityUpdatedAt: '2026-08-24T14:00:00.000Z',
    }
    const request = new Request(
      'http://localhost/api/finoo_identities/import-conflicts/1dc885ce-a2ce-4053-a069-e27ae0942327/resolve',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    )

    const response = await POST(request, {
      params: Promise.resolve({ id: '1dc885ce-a2ce-4053-a069-e27ae0942327' }),
    })

    expect(response.status).toBe(200)
    const payload = await response.json()
    expect(payload).toMatchObject({ state: 'resolved', isComplete: true })
    expect(JSON.stringify(payload)).not.toContain('44051401458')
    expect(authorizeConflictManagementActor).toHaveBeenCalledWith({
      scope: {
        actorUserId: '54af32b0-9209-48b2-a78d-13d2602ea741',
        tenantId: '5164d495-1865-4738-b459-2783999a761d',
        organizationId: 'd0d98cb3-28cf-4376-a61c-d270020f166f',
      },
      conflictId: '1dc885ce-a2ce-4053-a069-e27ae0942327',
      operation: 'resolve_conflict',
    })
    expect(authorizeConflictManagementActor.mock.invocationCallOrder[0]).toBeLessThan(
      runRouteMutationGuards.mock.invocationCallOrder[0],
    )
    expect(runRouteMutationGuards).toHaveBeenCalledTimes(1)
    expect(runRouteMutationGuards).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({ mutationPayload: { action: 'replace' } }),
    }))
    expect(resolveConflictForAuthorizedActor).toHaveBeenCalledWith({
      scope: {
        actorUserId: '54af32b0-9209-48b2-a78d-13d2602ea741',
        tenantId: '5164d495-1865-4738-b459-2783999a761d',
        organizationId: 'd0d98cb3-28cf-4376-a61c-d270020f166f',
      },
      conflictId: '1dc885ce-a2ce-4053-a069-e27ae0942327',
      input: body,
    })
  })

  it('returns an audited authorization denial before conflict mutation guards run', async () => {
    const authorizeConflictManagementActor = jest.fn(async () => {
      throw new CrudHttpError(403, { error: 'identity_access_denied' })
    })
    const resolveConflictForAuthorizedActor = jest.fn()
    createRequestContainer.mockResolvedValue({
      resolve: (key: string) => key === 'finooIdentityService'
        ? { authorizeConflictManagementActor, resolveConflictForAuthorizedActor }
        : (() => { throw new Error(`Unexpected dependency: ${key}`) })(),
    })
    const request = new Request(
      'http://localhost/api/finoo_identities/import-conflicts/1dc885ce-a2ce-4053-a069-e27ae0942327/resolve',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'dismiss',
          updatedAt: '2026-08-24T14:05:00.000Z',
          identityUpdatedAt: '2026-08-24T14:00:00.000Z',
        }),
      },
    )

    const response = await POST(request, {
      params: Promise.resolve({ id: '1dc885ce-a2ce-4053-a069-e27ae0942327' }),
    })

    expect(response.status).toBe(403)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(await response.json()).toEqual({ error: 'identity_access_denied' })
    expect(runRouteMutationGuards).not.toHaveBeenCalled()
    expect(resolveConflictForAuthorizedActor).not.toHaveBeenCalled()
  })
})
