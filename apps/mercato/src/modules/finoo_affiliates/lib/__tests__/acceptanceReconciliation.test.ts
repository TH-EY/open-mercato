import { reconcileAcceptedDeals } from '../acceptanceReconciliation'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('Finoo Accepted registry reconciliation', () => {
  it('reads only registry rows missing ledger transactions and dispatches bounded ids', async () => {
    const execute = jest.fn().mockResolvedValue([{ deal_id: 'deal-1' }, { deal_id: 'deal-2' }])
    const createTransaction = jest.fn().mockResolvedValue(true)
    const result = await reconcileAcceptedDeals(
      { getConnection: () => ({ execute }) } as never,
      { tenantId: 'tenant-1', organizationId: 'org-1' },
      createTransaction,
      10,
    )
    expect(result).toEqual({ selected: 2, succeeded: 2 })
    expect(execute.mock.calls[0]?.[0]).toContain('from finoo_deal_acceptances')
    expect(execute.mock.calls[0]?.[0]).toContain('inner join finoo_deal_attributions')
    expect(execute.mock.calls[0]?.[0]).toContain('inner join customer_deals')
    expect(execute.mock.calls[0]?.[0]).toContain('inner join finoo_affiliates')
    expect(execute.mock.calls[0]?.[0]).toContain('(attribution.affiliate_id is null or affiliate.id = attribution.affiliate_id)')
    expect(execute.mock.calls[0]?.[0]).toContain('affiliate.is_active = true')
    expect(execute.mock.calls[0]?.[0]).toContain('affiliate.deleted_at is null')
    expect(execute.mock.calls[0]?.[0]).toContain('(transaction.id is null or transaction.created_event_published_at is null)')
    expect(execute.mock.calls[0]?.[0]).not.toContain('customer_deal_stage_transitions')
    expect(execute.mock.calls[0]?.[1]).toEqual(['tenant-1', 'org-1', 10])
    expect(createTransaction.mock.calls).toEqual([['deal-1'], ['deal-2']])
  })

  it('reports selected no-op rows separately so a worker does not immediately continue', async () => {
    const execute = jest.fn().mockResolvedValue([{ deal_id: 'deal-1' }])
    const result = await reconcileAcceptedDeals(
      { getConnection: () => ({ execute }) } as never,
      { tenantId: 'tenant-1', organizationId: 'org-1' },
      jest.fn().mockResolvedValue(false),
      1,
    )
    expect(result).toEqual({ selected: 1, succeeded: 0 })
    const worker = readFileSync(resolve(process.cwd(), 'src/modules/finoo_affiliates/workers/acceptance-reconciliation.ts'), 'utf8')
    expect(worker).toContain('result.succeeded === result.selected')
  })
})
