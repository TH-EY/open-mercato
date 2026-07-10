import { NextRequest } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { GET } from '../route'

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: jest.fn(),
}))

jest.mock('@open-mercato/shared/lib/auth/server', () => ({
  getAuthFromRequest: jest.fn(),
}))

jest.mock('@open-mercato/core/modules/directory/utils/organizationScope', () => ({
  resolveOrganizationScopeForRequest: jest.fn(async () => ({ selectedId: 'org-1' })),
}))

jest.mock('@open-mercato/core/modules/directory/utils/organizationScopeFilter', () => ({
  resolveOrganizationScopeFilter: jest.fn(() => ({ where: { organizationId: 'org-1' } })),
}))

describe('GET /api/workflows/tasks', () => {
  const findAndCount = jest.fn(async () => [[], 0])
  const find = jest.fn(async () => [])
  const userHasAllFeatures = jest.fn()
  const em = { findAndCount, find }
  const container = {
    resolve: jest.fn((name: string) => {
      if (name === 'em') return em
      if (name === 'rbacService') return { userHasAllFeatures }
      return null
    }),
  }

  beforeEach(() => {
    jest.clearAllMocks()
    ;(createRequestContainer as jest.Mock).mockResolvedValue(container)
    ;(getAuthFromRequest as jest.Mock).mockResolvedValue({
      sub: 'user-1',
      tenantId: 'tenant-1',
      orgId: 'org-1',
      roles: ['Sales'],
    })
  })

  it('builds a real personal predicate for myTasks=true', async () => {
    const response = await GET(new NextRequest('http://localhost/api/workflows/tasks?myTasks=true'))

    expect(response.status).toBe(200)
    expect(userHasAllFeatures).not.toHaveBeenCalled()
    expect(findAndCount).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tenantId: 'tenant-1',
        organizationId: 'org-1',
        $or: expect.arrayContaining([
          { assignedTo: 'user-1' },
          { claimedBy: 'user-1' },
          expect.objectContaining({
            assignedTo: null,
            claimedBy: null,
            status: 'PENDING',
            assignedToRoles: { $overlap: ['Sales'] },
          }),
        ]),
      }),
      expect.anything(),
    )
  })

  it('rejects broad listing for a non-manager', async () => {
    userHasAllFeatures.mockResolvedValue(false)
    const response = await GET(new NextRequest('http://localhost/api/workflows/tasks'))

    expect(response.status).toBe(403)
    expect(findAndCount).not.toHaveBeenCalled()
  })

  it('requires source entity filters as a pair', async () => {
    const response = await GET(new NextRequest(
      'http://localhost/api/workflows/tasks?myTasks=true&entityId=deal-1',
    ))

    expect(response.status).toBe(400)
    expect(findAndCount).not.toHaveBeenCalled()
  })

  it('applies source filtering before task pagination', async () => {
    find.mockResolvedValueOnce([{ id: 'instance-1', metadata: { entityType: 'customers.deal', entityId: 'deal-1' } }])
    const response = await GET(new NextRequest(
      'http://localhost/api/workflows/tasks?myTasks=true&entityType=customers.deal&entityId=deal-1&order=oldest&limit=1',
    ))

    expect(response.status).toBe(200)
    expect(findAndCount).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ workflowInstanceId: { $in: ['instance-1'] } }),
      expect.objectContaining({ orderBy: { createdAt: 'ASC' }, limit: 1 }),
    )
  })
})
