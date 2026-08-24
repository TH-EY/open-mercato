import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { GET } from '../route'

const getAuthFromRequest = jest.fn()
const createRequestContainer = jest.fn()
const resolveOrganizationScopeForRequest = jest.fn()

jest.mock('@open-mercato/shared/lib/auth/server', () => ({
  getAuthFromRequest: (...args: unknown[]) => getAuthFromRequest(...args),
}))

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: (...args: unknown[]) => createRequestContainer(...args),
}))

jest.mock('@open-mercato/core/modules/directory/utils/organizationScope', () => ({
  resolveOrganizationScopeForRequest: (...args: unknown[]) => resolveOrganizationScopeForRequest(...args),
}))

describe('FINOO identity status route', () => {
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
  })

  it('returns only safe field statuses for an ordinary Person viewer', async () => {
    const readStatusForPersonViewer = jest.fn(async () => ({
      isComplete: false,
      statuses: {
        pesel: 'complete',
        documentType: 'complete',
        issuingCountryCode: 'missing',
        documentNumber: 'missing',
        issuedOn: 'complete',
        expiresOn: 'missing',
      },
    }))
    createRequestContainer.mockResolvedValue({
      resolve: (key: string) => key === 'finooIdentityService'
        ? { readStatusForPersonViewer }
        : (() => { throw new Error(`Unexpected dependency: ${key}`) })(),
    })

    const response = await GET(
      new Request('http://localhost/api/finoo_identities/people/ee823a18-e50c-4de4-9d71-4f516d7d754e/status'),
      { params: Promise.resolve({ personId: 'ee823a18-e50c-4de4-9d71-4f516d7d754e' }) },
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    const body = await response.json()
    expect(body.statuses.documentNumber).toBe('missing')
    expect(JSON.stringify(body)).not.toContain('44051401458')
  })

  it('returns the service authorization denial without status data', async () => {
    const readStatusForPersonViewer = jest.fn(async () => {
      throw new CrudHttpError(403, { error: 'person_access_denied' })
    })
    createRequestContainer.mockResolvedValue({
      resolve: () => ({ readStatusForPersonViewer }),
    })

    const response = await GET(
      new Request('http://localhost/api/finoo_identities/people/ee823a18-e50c-4de4-9d71-4f516d7d754e/status'),
      { params: Promise.resolve({ personId: 'ee823a18-e50c-4de4-9d71-4f516d7d754e' }) },
    )

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'person_access_denied' })
  })
})
