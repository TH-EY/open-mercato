import { LockMode, type EntityManager } from '@mikro-orm/postgresql'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import {
  activateAffiliateForInvitation,
  ensureAffiliateForInvitation,
  generateAffiliateCode,
  normalizeAffiliateEmail,
  resolveDefaultAffiliateDestination,
  withReservedAffiliateCode,
} from '../membership'

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: jest.fn(),
}))

const findOne = jest.mocked(findOneWithDecryption)

describe('Finoo affiliate membership', () => {
  beforeEach(() => jest.clearAllMocks())

  it('normalizes email and generates uppercase 24-character codes', () => {
    expect(normalizeAffiliateEmail(' Affiliate@Example.COM ')).toBe('affiliate@example.com')
    expect(generateAffiliateCode()).toMatch(/^[A-F0-9]{24}$/)
  })

  it('uses a localhost destination only in the managed integration runtime', () => {
    const originalIntegration = process.env.OM_INTEGRATION_TEST
    const originalDestination = process.env.OM_FINOO_DEFAULT_AFFILIATE_DESTINATION_URL
    const originalHosts = process.env.OM_FINOO_AFFILIATE_REDIRECT_HOSTS
    delete process.env.OM_FINOO_DEFAULT_AFFILIATE_DESTINATION_URL
    delete process.env.OM_FINOO_AFFILIATE_REDIRECT_HOSTS
    process.env.OM_INTEGRATION_TEST = 'true'

    expect(resolveDefaultAffiliateDestination()).toBe('http://localhost/')

    if (originalIntegration === undefined) delete process.env.OM_INTEGRATION_TEST
    else process.env.OM_INTEGRATION_TEST = originalIntegration
    if (originalDestination === undefined) delete process.env.OM_FINOO_DEFAULT_AFFILIATE_DESTINATION_URL
    else process.env.OM_FINOO_DEFAULT_AFFILIATE_DESTINATION_URL = originalDestination
    if (originalHosts === undefined) delete process.env.OM_FINOO_AFFILIATE_REDIRECT_HOSTS
    else process.env.OM_FINOO_AFFILIATE_REDIRECT_HOSTS = originalHosts
  })

  it('serializes the cross-table lookup and creation under one advisory transaction lock', async () => {
    findOne.mockResolvedValue(null)
    const execute = jest.fn().mockResolvedValue([])
    const transactionalEm = { getConnection: () => ({ execute }) } as unknown as EntityManager
    const transactional = jest.fn(async (callback: (em: EntityManager) => Promise<string>) => callback(transactionalEm))
    const em = { transactional } as unknown as EntityManager

    const result = await withReservedAffiliateCode(em, async (lockedEm, code) => {
      expect(lockedEm).toBe(transactionalEm)
      return code
    })

    expect(result).toMatch(/^[A-F0-9]{24}$/)
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_xact_lock'),
      ['finoo_affiliates:code-reservation'],
    )
    expect(findOne).toHaveBeenCalledTimes(2)
  })

  it('loads an accepted invitation only inside the explicit tenant and organization scope', async () => {
    findOne.mockResolvedValueOnce(null)
    const transactionalEm = { getConnection: () => ({ execute: jest.fn().mockResolvedValue([]) }) } as unknown as EntityManager
    const em = {
      transactional: (callback: (lockedEm: EntityManager) => Promise<unknown>) => callback(transactionalEm),
    } as unknown as EntityManager
    await expect(activateAffiliateForInvitation(
      em,
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
      { tenantId: 'tenant-a', organizationId: 'organization-a' },
    )).rejects.toMatchObject({ status: 409 })
    expect(findOne.mock.calls[0]?.[2]).toEqual({
      id: '00000000-0000-4000-8000-000000000001',
      tenantId: 'tenant-a',
      organizationId: 'organization-a',
    })
    expect(findOne.mock.calls[0]?.[4]).toEqual({ tenantId: 'tenant-a', organizationId: 'organization-a' })
  })

  it('locks the invitation row before checking or creating its affiliate membership', async () => {
    findOne.mockResolvedValueOnce(null)
    const transactionalEm = { getConnection: () => ({ execute: jest.fn().mockResolvedValue([]) }) } as unknown as EntityManager
    const em = {
      transactional: (callback: (lockedEm: EntityManager) => Promise<unknown>) => callback(transactionalEm),
    } as unknown as EntityManager

    await expect(ensureAffiliateForInvitation(
      em,
      '00000000-0000-4000-8000-000000000001',
      { tenantId: 'tenant-a', organizationId: 'organization-a' },
    )).rejects.toMatchObject({ status: 404 })

    expect(findOne.mock.calls[0]?.[3]).toEqual({ lockMode: LockMode.PESSIMISTIC_WRITE })
  })

  it('flushes a new primary link before assigning its database-generated id to the membership', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/modules/finoo_affiliates/lib/membership.ts'), 'utf8')
    const persistLink = source.indexOf('transactionalEm.persist(link)')
    const firstFlushAfterPersist = source.indexOf('await transactionalEm.flush()', persistLink)
    const assignPrimaryLink = source.indexOf('affiliate.primaryLinkId = link.id', persistLink)
    expect(persistLink).toBeGreaterThan(0)
    expect(firstFlushAfterPersist).toBeGreaterThan(persistLink)
    expect(firstFlushAfterPersist).toBeLessThan(assignPrimaryLink)
  })
})
