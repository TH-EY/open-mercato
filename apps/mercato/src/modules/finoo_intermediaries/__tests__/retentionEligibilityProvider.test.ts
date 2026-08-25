import { asValue, createContainer, InjectionMode } from 'awilix'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import { register } from '../di'
import {
  createFinooIntermediaryRetentionEligibilityProvider,
  summarizeIntermediaryRetentionRows,
} from '../lib/retentionEligibilityProvider'

describe('summarizeIntermediaryRetentionRows', () => {
  it('separates live exclusions from the latest deleted membership', () => {
    const earlier = new Date('2026-08-20T10:00:00.000Z')
    const later = new Date('2026-08-22T10:00:00.000Z')

    const result = summarizeIntermediaryRetentionRows([
      { customerUserId: 'user-active', deletedAt: null },
      { customerUserId: 'user-deleted', deletedAt: later },
      { customerUserId: 'user-deleted', deletedAt: earlier },
    ])

    expect(result.activeCustomerUserIds).toEqual(['user-active'])
    expect(result.latestDeletedAtByCustomerUserId.get('user-deleted')).toEqual(later)
  })

  it('resolves the provider with the application CLASSIC injection mode', () => {
    const container = createContainer({ injectionMode: InjectionMode.CLASSIC })
    container.register({ em: asValue({ marker: 'em' }) })
    register(container as AppContainer)

    expect(container.resolve('finooIntermediaryRetentionEligibilityProvider')).toBeDefined()
  })

  it('uses the caller transaction for retention reads', async () => {
    const execute = jest.fn().mockResolvedValue([{ customer_user_id: 'user-1', deleted_at: null }])
    const query = {
      selectFrom: jest.fn(),
      select: jest.fn(),
      where: jest.fn(),
      execute,
    }
    query.selectFrom.mockReturnValue(query)
    query.select.mockReturnValue(query)
    query.where.mockReturnValue(query)
    const rootGetKysely = jest.fn(() => { throw new Error('root EM must not be used') })
    const transactionGetKysely = jest.fn(() => query)
    const provider = createFinooIntermediaryRetentionEligibilityProvider({
      getKysely: rootGetKysely,
    } as never)

    const result = await provider.findFacts({
      tenantId: 'tenant-1',
      organizationId: 'organization-1',
      customerUserIds: ['user-1'],
      em: { getKysely: transactionGetKysely } as never,
    })

    expect(result.activeCustomerUserIds).toEqual(['user-1'])
    expect(transactionGetKysely).toHaveBeenCalledTimes(1)
    expect(rootGetKysely).not.toHaveBeenCalled()
  })
})
