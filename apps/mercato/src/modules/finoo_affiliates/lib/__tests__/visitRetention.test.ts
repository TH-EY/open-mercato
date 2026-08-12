import type { EntityManager } from '@mikro-orm/postgresql'
import {
  anonymizeExpiredAffiliateVisitors,
  FINOO_AFFILIATE_VISITOR_WINDOW_MS,
} from '../visitRetention'

describe('Finoo affiliate visitor retention', () => {
  it('anonymizes a bounded tenant- and organization-scoped batch after the uniqueness window', async () => {
    const execute = jest.fn().mockResolvedValue({ affectedRows: 7 })
    const em = {
      getConnection: () => ({ execute }),
    } as unknown as EntityManager
    const now = new Date('2026-08-12T12:00:00.000Z')

    await expect(anonymizeExpiredAffiliateVisitors(
      em,
      { tenantId: 'tenant-a', organizationId: 'organization-a' },
      { now, batchSize: 25 },
    )).resolves.toBe(7)

    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('visitor_hash is not null'),
      [
        now,
        'tenant-a',
        'organization-a',
        new Date(now.getTime() - FINOO_AFFILIATE_VISITOR_WINDOW_MS),
        25,
      ],
      'run',
    )
    expect(execute.mock.calls[0]?.[0]).toContain('tenant_id = ?')
    expect(execute.mock.calls[0]?.[0]).toContain('organization_id = ?')
    expect(execute.mock.calls[0]?.[0]).toContain('limit ?')
  })

  it('rejects an invalid batch size before issuing SQL', async () => {
    const execute = jest.fn()
    const em = {
      getConnection: () => ({ execute }),
    } as unknown as EntityManager

    await expect(anonymizeExpiredAffiliateVisitors(
      em,
      { tenantId: 'tenant-a', organizationId: 'organization-a' },
      { batchSize: 0 },
    )).rejects.toThrow('batch size')
    expect(execute).not.toHaveBeenCalled()
  })
})
