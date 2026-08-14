import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { createAffiliateTransactionForDeal } from '../transactions'

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: jest.fn(),
}))

const findOne = jest.mocked(findOneWithDecryption)
const scope = { tenantId: 'tenant-1', organizationId: 'organization-1' }

describe('Finoo affiliate transaction idempotency', () => {
  beforeEach(() => jest.clearAllMocks())

  it('returns the committed winner only for the scoped Deal uniqueness constraint', async () => {
    const winner = { id: 'transaction-1', dealId: 'deal-1' }
    findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(winner as never)
    const databaseError = Object.assign(
      new Error('duplicate key value violates unique constraint "finoo_affiliate_transactions_scope_deal_unique"'),
      { code: '23505', constraint: 'finoo_affiliate_transactions_scope_deal_unique' },
    )
    const em = {
      transactional: jest.fn().mockRejectedValue(databaseError),
      fork: jest.fn().mockReturnValue({}),
    }

    await expect(createAffiliateTransactionForDeal(em as never, 'deal-1', scope)).resolves.toEqual({
      transaction: winner,
      created: false,
    })
    expect(em.fork).toHaveBeenCalledTimes(1)
  })

  it('rethrows unrelated database failures without masking them as a replay', async () => {
    findOne.mockResolvedValueOnce(null)
    const databaseError = Object.assign(new Error('another unique constraint'), {
      code: '23505',
      constraint: 'another_constraint',
    })
    const em = {
      transactional: jest.fn().mockRejectedValue(databaseError),
      fork: jest.fn(),
    }

    await expect(createAffiliateTransactionForDeal(em as never, 'deal-1', scope)).rejects.toBe(databaseError)
    expect(em.fork).not.toHaveBeenCalled()
  })

  it('snapshots the current attributed affiliate, amount, Deal and Accepted time in tenant scope', async () => {
    const acceptance = { acceptedAt: new Date('2026-08-13T10:00:00.000Z') }
    const attribution = {
      affiliateId: 'affiliate-1',
      affiliateUserId: 'user-1',
      commissionAmount: 125,
      companyName: 'Finoo Company',
    }
    const deal = { title: 'Finoo Deal' }
    const affiliate = { id: 'affiliate-1', customerUserId: 'user-1' }
    const dictionary = { id: 'dictionary-1' }
    const statusEntry = { id: 'processing-1' }
    findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(acceptance as never)
      .mockResolvedValueOnce(attribution as never)
      .mockResolvedValueOnce(deal as never)
      .mockResolvedValueOnce(affiliate as never)
      .mockResolvedValueOnce(dictionary as never)
      .mockResolvedValueOnce(statusEntry as never)
    const created: Record<string, unknown>[] = []
    const transactionalEm = {
      create: jest.fn((_entity, input) => { created.push(input); return input }),
      persist: jest.fn(),
      flush: jest.fn().mockResolvedValue(undefined),
    }
    const em = { transactional: (callback: (trx: unknown) => unknown) => callback(transactionalEm) }

    const result = await createAffiliateTransactionForDeal(em as never, 'deal-1', scope)

    expect(result.created).toBe(true)
    expect(created[0]).toMatchObject({
      ...scope,
      affiliateId: 'affiliate-1',
      affiliateUserId: 'user-1',
      dealId: 'deal-1',
      dealName: 'Finoo Deal',
      dealCompany: 'Finoo Company',
      commissionAmount: 125,
      commissionMode: 'legacy_deal_amount',
      commissionRateBps: null,
      commissionFixedAmount: null,
      commissionBaseAmount: null,
      commissionStatus: 'processing',
      acceptedAt: acceptance.acceptedAt,
    })
    expect(findOne.mock.calls[4]?.[2]).toMatchObject({ deletedAt: null })
  })

  it('snapshots an affiliate percentage rule and the accepted Deal value', async () => {
    const acceptance = {
      acceptedAt: new Date('2026-08-14T10:00:00.000Z'),
      dealValueAmount: '1234.56',
      dealValueCurrency: 'PLN',
    }
    findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(acceptance as never)
      .mockResolvedValueOnce({
        affiliateId: 'affiliate-1',
        affiliateUserId: 'user-1',
        commissionAmount: 125,
        companyName: null,
      } as never)
      .mockResolvedValueOnce({ title: 'Percentage Deal', valueAmount: '9999.99', valueCurrency: 'PLN' } as never)
      .mockResolvedValueOnce({
        id: 'affiliate-1',
        customerUserId: 'user-1',
        commissionMode: 'percentage',
        commissionRateBps: 750,
        commissionFixedAmount: null,
      } as never)
      .mockResolvedValueOnce({ id: 'dictionary-1' } as never)
      .mockResolvedValueOnce({ id: 'processing-1' } as never)
    const created: Record<string, unknown>[] = []
    const transactionalEm = {
      create: jest.fn((_entity, input) => { created.push(input); return input }),
      persist: jest.fn(),
      flush: jest.fn().mockResolvedValue(undefined),
    }
    const em = { transactional: (callback: (trx: unknown) => unknown) => callback(transactionalEm) }

    await createAffiliateTransactionForDeal(em as never, 'deal-1', scope)

    expect(created[0]).toMatchObject({
      commissionAmount: 93,
      commissionMode: 'percentage',
      commissionRateBps: 750,
      commissionFixedAmount: null,
      commissionBaseAmount: '1234.56',
    })
    expect(findOne.mock.calls[5]?.[3]).toMatchObject({ lockMode: expect.anything() })
  })

  it('can recover an Accepted transaction while the source Deal is already soft-deleted', async () => {
    findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ acceptedAt: new Date('2026-08-13T10:00:00.000Z') } as never)
      .mockResolvedValueOnce({
        affiliateId: 'affiliate-1',
        affiliateUserId: 'user-1',
        commissionAmount: 125,
        companyName: 'Finoo Company',
      } as never)
      .mockResolvedValueOnce({ title: 'Deleted Finoo Deal', deletedAt: new Date() } as never)
      .mockResolvedValueOnce({ id: 'affiliate-1', customerUserId: 'user-1' } as never)
      .mockResolvedValueOnce({ id: 'dictionary-1' } as never)
      .mockResolvedValueOnce({ id: 'processing-1' } as never)
    const transactionalEm = {
      create: jest.fn((_entity, input) => input),
      persist: jest.fn(),
      flush: jest.fn().mockResolvedValue(undefined),
    }
    const em = { transactional: (callback: (trx: unknown) => unknown) => callback(transactionalEm) }

    const result = await createAffiliateTransactionForDeal(
      em as never,
      'deal-1',
      scope,
      { includeDeletedDeal: true },
    )

    expect(result.created).toBe(true)
    expect(findOne.mock.calls[4]?.[2]).toEqual({ id: 'deal-1', ...scope })
  })
})
