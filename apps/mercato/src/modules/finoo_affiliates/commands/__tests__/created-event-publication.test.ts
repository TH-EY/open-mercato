const mockCommands = new Map<string, { execute: (input: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<unknown> }>()
const mockRegisterCommand = jest.fn((command: { id: string; execute: (input: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<unknown> }) => {
  mockCommands.set(command.id, command)
})
const mockCreateTransaction = jest.fn()
const mockCreatePayout = jest.fn()
const mockEmit = jest.fn()

jest.mock('@open-mercato/shared/lib/commands', () => ({ registerCommand: mockRegisterCommand }))
jest.mock('@open-mercato/shared/lib/commands/scope', () => ({
  ensureTenantScope: jest.fn(),
  ensureOrganizationScope: jest.fn(),
}))
jest.mock('../../lib/transactions', () => ({
  createAffiliateTransactionForDeal: mockCreateTransaction,
  transitionAffiliateTransaction: jest.fn(),
  undoAffiliateTransactionTransition: jest.fn(),
}))
jest.mock('../../lib/payouts', () => ({ createAffiliatePayout: mockCreatePayout }))
jest.mock('../../events', () => ({ emitFinooAffiliateEvent: mockEmit }))

import '../transactions'
import '../payouts'

const scope = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  organizationId: '00000000-0000-4000-8000-000000000002',
}

function commandContext(nativeUpdate: jest.Mock) {
  const em = { fork: () => em, nativeUpdate }
  return {
    container: { resolve: () => em },
    auth: { tenantId: scope.tenantId },
    selectedOrganizationId: scope.organizationId,
    organizationIds: [scope.organizationId],
    organizationScope: null,
    systemActor: true,
  }
}

describe('financial created-event publication repair', () => {
  beforeEach(() => jest.clearAllMocks())

  it('retries a transaction event after a post-commit emit failure and then records publication', async () => {
    const nativeUpdate = jest.fn().mockResolvedValue(1)
    const transaction = {
      id: '00000000-0000-4000-8000-000000000003',
      dealId: '00000000-0000-4000-8000-000000000004',
      affiliateId: '00000000-0000-4000-8000-000000000005',
      affiliateUserId: '00000000-0000-4000-8000-000000000006',
      commissionStatus: 'processing',
      commissionAmount: 100,
      createdEventPublishedAt: null,
      ...scope,
    }
    mockCreateTransaction.mockResolvedValue({ transaction, created: false })
    mockEmit.mockRejectedValueOnce(new Error('queue unavailable')).mockResolvedValueOnce(undefined)
    const command = mockCommands.get('finoo_affiliates.transaction.create')

    await expect(command?.execute({ dealId: transaction.dealId }, commandContext(nativeUpdate))).rejects.toThrow('queue unavailable')
    expect(nativeUpdate).not.toHaveBeenCalled()
    await command?.execute({ dealId: transaction.dealId }, commandContext(nativeUpdate))

    expect(mockEmit).toHaveBeenCalledTimes(2)
    expect(nativeUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: transaction.id, createdEventPublishedAt: null, ...scope }),
      expect.objectContaining({ createdEventPublishedAt: expect.any(Date) }),
    )
    expect(transaction.createdEventPublishedAt).toBeInstanceOf(Date)
  })

  it('retries a payout event after a post-commit emit failure and then records publication', async () => {
    const nativeUpdate = jest.fn().mockResolvedValue(1)
    const payout = {
      id: '00000000-0000-4000-8000-000000000007',
      affiliateId: '00000000-0000-4000-8000-000000000005',
      affiliateUserId: '00000000-0000-4000-8000-000000000006',
      paymentReference: 'FINOO-REF',
      amount: '100',
      currency: 'PLN',
      createdEventPublishedAt: null,
      ...scope,
    }
    mockCreatePayout.mockResolvedValue({ payout, created: false, transactionIds: ['00000000-0000-4000-8000-000000000008'] })
    mockEmit.mockRejectedValueOnce(new Error('queue unavailable')).mockResolvedValueOnce(undefined)
    const command = mockCommands.get('finoo_affiliates.payout.create')
    const input = {
      paymentReference: payout.paymentReference,
      affiliateUpdatedAt: '2026-08-13T10:00:00.000Z',
      transactions: [{ id: '00000000-0000-4000-8000-000000000008', updatedAt: '2026-08-13T11:00:00.000Z' }],
      ...scope,
    }

    await expect(command?.execute(input, commandContext(nativeUpdate))).rejects.toThrow('queue unavailable')
    expect(nativeUpdate).not.toHaveBeenCalled()
    await command?.execute(input, commandContext(nativeUpdate))

    expect(mockEmit).toHaveBeenCalledTimes(2)
    expect(nativeUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: payout.id, createdEventPublishedAt: null, ...scope }),
      expect.objectContaining({ createdEventPublishedAt: expect.any(Date) }),
    )
    expect(payout.createdEventPublishedAt).toBeInstanceOf(Date)
  })
})
