import type { EntityManager } from '@mikro-orm/postgresql'
import {
  filterIntermediaryDashboardNav,
  hasActiveIntermediaryPortalRole,
} from '../lib/portalNavigation'
import { enabledModules } from '../../../modules'

const tenantId = '11111111-1111-4111-8111-111111111111'
const organizationId = '22222222-2222-4222-8222-222222222222'
const customerUserId = '33333333-3333-4333-8333-333333333333'

describe('finoo_intermediaries portal navigation policy', () => {
  it('wires the private Dashboard page and portal nav overrides', () => {
    const moduleEntry = enabledModules.find((entry) => entry.id === 'finoo_intermediaries')

    expect(moduleEntry?.overrides?.routes?.pages?.['/frontend/[orgSlug]/portal/dashboard'])
      .toMatchObject({ load: expect.any(Function) })
    expect(moduleEntry?.overrides?.routes?.api?.['GET /api/customer_accounts/portal/nav'])
      .toMatchObject({ handler: expect.any(Function) })
  })

  it('removes only Dashboard from intermediary navigation', () => {
    const groups = [
      {
        id: 'main',
        items: [
          { id: 'dashboard', href: '/finoo/portal/dashboard', label: 'Dashboard' },
          { id: 'assigned-deals', href: '/finoo/portal/intermediary/deals', label: 'Assigned deals' },
        ],
      },
      {
        id: 'account',
        items: [{ id: 'profile', href: '/finoo/portal/profile', label: 'Profile' }],
      },
    ]

    expect(filterIntermediaryDashboardNav(groups, 'finoo')).toEqual([
      {
        id: 'main',
        items: [{ id: 'assigned-deals', href: '/finoo/portal/intermediary/deals', label: 'Assigned deals' }],
      },
      {
        id: 'account',
        items: [{ id: 'profile', href: '/finoo/portal/profile', label: 'Profile' }],
      },
    ])
    expect(groups[0].items).toHaveLength(2)
  })

  it('recognizes only an active scoped intermediary membership', async () => {
    const role = { id: '44444444-4444-4444-8444-444444444444', slug: 'intermediary' }
    const user = { id: customerUserId }
    const em = {
      find: jest.fn(async () => [role]),
      findOne: jest.fn()
        .mockResolvedValueOnce(user)
        .mockResolvedValueOnce({ id: '55555555-5555-4555-8555-555555555555' }),
    } as unknown as EntityManager

    await expect(hasActiveIntermediaryPortalRole(em, {
      tenantId,
      organizationId,
      customerUserId,
    })).resolves.toBe(true)

    expect(em.find).toHaveBeenCalledWith(expect.any(Function), {
      tenantId,
      organizationId,
      slug: 'intermediary',
      deletedAt: null,
    })
    expect(em.findOne).toHaveBeenNthCalledWith(1, expect.any(Function), {
      id: customerUserId,
      tenantId,
      organizationId,
      isActive: true,
      deletedAt: null,
    })
    expect(em.findOne).toHaveBeenNthCalledWith(2, expect.any(Function), {
      user: user.id,
      role: role.id,
      deletedAt: null,
    })
  })

  it.each([
    ['foreign organization', { id: customerUserId, tenantId, organizationId: 'foreign-org', isActive: true, deletedAt: null }],
    ['inactive user', { id: customerUserId, tenantId, organizationId, isActive: false, deletedAt: null }],
    ['deleted user', { id: customerUserId, tenantId, organizationId, isActive: true, deletedAt: new Date() }],
  ])('rejects an intermediary membership for a %s', async (_label, candidate) => {
    const role = { id: '44444444-4444-4444-8444-444444444444', slug: 'intermediary' }
    const findOne = jest.fn(async (_entity: unknown, query: Record<string, unknown>) => {
      if (!('id' in query)) return { id: 'membership-id' }
      return candidate.id === query.id
        && candidate.tenantId === query.tenantId
        && candidate.organizationId === query.organizationId
        && candidate.isActive === query.isActive
        && candidate.deletedAt === query.deletedAt
        ? candidate
        : null
    })
    const em = {
      find: jest.fn(async () => [role]),
      findOne,
    } as unknown as EntityManager

    await expect(hasActiveIntermediaryPortalRole(em, {
      tenantId,
      organizationId,
      customerUserId,
    })).resolves.toBe(false)

    expect(findOne).toHaveBeenCalledTimes(1)
  })
})
