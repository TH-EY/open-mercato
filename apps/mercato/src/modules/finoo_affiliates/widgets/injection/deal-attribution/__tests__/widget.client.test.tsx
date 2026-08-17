/**
 * @jest-environment jsdom
 */
import * as React from 'react'
import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import DealAttributionWidget from '../widget.client'

const mockRunMutation = jest.fn(
  async ({ operation }: { operation: () => Promise<unknown> }) => operation(),
)
const mockTranslate = (key: string, fallback: string) => (
  key === 'finooAffiliates.transactions.statuses.approved' ? 'Approved' : fallback
)

jest.mock('@open-mercato/shared/lib/i18n/context', () => ({
  useT: () => mockTranslate,
}))

jest.mock('@open-mercato/ui/backend/conflicts', () => ({ surfaceRecordConflict: jest.fn(() => false) }))
jest.mock('@open-mercato/ui/backend/FlashMessages', () => ({ flash: jest.fn() }))

jest.mock('@open-mercato/ui/backend/injection/useGuardedMutation', () => ({
  useGuardedMutation: () => ({
    runMutation: mockRunMutation,
    retryLastMutation: jest.fn(async () => false),
  }),
}))

jest.mock('@open-mercato/ui/backend/utils/apiCall', () => ({
  readApiResultOrThrow: jest.fn(),
  withScopedApiRequestHeaders: (_headers: Record<string, string>, operation: () => Promise<unknown>) => operation(),
}))

jest.mock('@open-mercato/ui/backend/utils/optimisticLock', () => ({
  buildOptimisticLockHeader: () => ({ 'if-unmodified-since': '2026-08-17T00:00:00.000Z' }),
}))

const mockReadApiResult = readApiResultOrThrow as jest.MockedFunction<typeof readApiResultOrThrow>

const attribution = {
  id: '11111111-1111-4111-8111-111111111111',
  affiliateUserId: '22222222-2222-4222-8222-222222222222',
  affiliateCode: 'AFFILIATECODE',
  landingPage: null,
  initialReferrer: null,
  commissionStatusEntryId: '33333333-3333-4333-8333-333333333333',
  commissionAmount: 275,
  affiliateProgramStatus: 'processing',
  affiliateTransactionId: null,
  affiliateTransactionAmount: null,
  affiliateTransactionCurrency: null,
  affiliateTransactionStatus: null,
  affiliateTransactionCommissionMode: null,
  updatedAt: '2026-08-17T00:00:00.000Z',
} as const

function payload(commissionMode: 'percentage' | 'fixed' | null, transaction = false) {
  return {
    attribution: transaction ? {
      ...attribution,
      affiliateProgramStatus: 'approved' as const,
      affiliateTransactionId: '44444444-4444-4444-8444-444444444444',
      affiliateTransactionAmount: 875,
      affiliateTransactionCurrency: 'PLN',
      affiliateTransactionStatus: 'approved' as const,
      affiliateTransactionCommissionMode: commissionMode ?? 'legacy_deal_amount',
    } : attribution,
    affiliates: [{
      id: attribution.affiliateUserId,
      displayName: 'Affiliate One',
      email: 'affiliate@example.test',
      commissionMode,
    }],
    statuses: [{ id: attribution.commissionStatusEntryId, value: 'waiting', label: 'Waiting' }],
  }
}

function renderWidget(editorPayload: ReturnType<typeof payload>) {
  mockReadApiResult.mockImplementation(async (_url, options) => (
    options?.method === 'PUT'
      ? { id: attribution.id, updatedAt: attribution.updatedAt }
      : editorPayload
  ))
  render(<DealAttributionWidget context={{ dealId: attribution.id }} disabled={false} />)
}

describe('DealAttributionWidget', () => {
  beforeEach(() => {
    mockRunMutation.mockClear()
    mockReadApiResult.mockReset()
  })

  it.each(['percentage', 'fixed'] as const)('shows the pending state and omits the legacy amount for %s rules', async (commissionMode) => {
    renderWidget(payload(commissionMode))

    expect(await screen.findByText('Not calculated yet')).toBeVisible()
    expect(screen.getByText(/calculated and snapshotted when the Deal first reaches Accepted/)).toBeVisible()
    expect(screen.queryByLabelText('Legacy commission amount')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      const request = mockReadApiResult.mock.calls.find(([, options]) => options?.method === 'PUT')?.[1]
      expect(request).toBeDefined()
      expect(JSON.parse(String(request?.body))).not.toHaveProperty('commissionAmount')
    })
  })

  it('shows canonical transaction amount, currency, and status as read-only values', async () => {
    renderWidget(payload('percentage', true))

    expect(await screen.findByText('875 PLN')).toBeVisible()
    expect(screen.getByText('Approved')).toBeVisible()
    expect(screen.queryByText('Not calculated yet')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Legacy commission amount')).not.toBeInTheDocument()
  })

  it('does not expose or submit the legacy fallback after its transaction is snapshotted', async () => {
    renderWidget(payload(null, true))

    expect(await screen.findByText('875 PLN')).toBeVisible()
    expect(screen.queryByLabelText('Legacy commission amount')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      const request = mockReadApiResult.mock.calls.find(([, options]) => options?.method === 'PUT')?.[1]
      expect(request).toBeDefined()
      expect(JSON.parse(String(request?.body))).not.toHaveProperty('commissionAmount')
    })
  })

  it('keeps an explicit legacy fallback input and submits its existing amount', async () => {
    renderWidget(payload(null))

    const legacyAmount = await screen.findByLabelText('Legacy commission amount')
    expect(legacyAmount).toHaveValue(275)

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      const request = mockReadApiResult.mock.calls.find(([, options]) => options?.method === 'PUT')?.[1]
      expect(JSON.parse(String(request?.body))).toMatchObject({ commissionAmount: 275 })
    })
  })
})
