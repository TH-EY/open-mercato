/**
 * @jest-environment jsdom
 */
import * as React from 'react'
import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import PayoutPreviewDialog, { type PayoutPreview } from '../payout-preview-dialog.client'

const mockRunMutation = jest.fn(
  async ({ operation }: { operation: () => Promise<unknown> }) => operation(),
)

jest.mock('@open-mercato/shared/lib/i18n/context', () => ({
  useT: () => (_key: string, fallback: string) => fallback,
}))

jest.mock('@open-mercato/ui/backend/injection/useGuardedMutation', () => ({
  useGuardedMutation: () => ({
    runMutation: mockRunMutation,
    retryLastMutation: jest.fn(async () => false),
  }),
}))

jest.mock('@open-mercato/ui/backend/utils/apiCall', () => ({
  readApiResultOrThrow: jest.fn(),
}))

const mockReadApiResult = readApiResultOrThrow as jest.MockedFunction<typeof readApiResultOrThrow>

const preview: PayoutPreview = {
  batchId: 'batch-1',
  selectedCount: 1,
  affiliateCount: 1,
  totalAmount: '100',
  currency: 'PLN',
  groups: [{
    paymentReference: 'FINOO-REF',
    affiliateId: '00000000-0000-4000-8000-000000000001',
    affiliateEmail: 'affiliate@example.test',
    affiliateUpdatedAt: '2026-08-18T10:00:00.000Z',
    accountHolderName: 'Affiliate',
    accountNumber: 'PL001',
    amount: '100',
    currency: 'PLN',
    selectedCount: 1,
    transactions: [{ id: '00000000-0000-4000-8000-000000000002', updatedAt: '2026-08-18T10:00:00.000Z' }],
    expiresAt: '2026-08-18T10:15:00.000Z',
  }],
}

describe('PayoutPreviewDialog', () => {
  beforeEach(() => {
    mockRunMutation.mockClear()
    mockReadApiResult.mockReset()
  })

  it('enqueues only one payout while the first keyboard submission is pending', async () => {
    let resolveRequest: (value: { progressJobId: string }) => void = () => undefined
    mockReadApiResult.mockReturnValue(new Promise((resolve) => { resolveRequest = resolve }))
    const onComplete = jest.fn()
    render(<PayoutPreviewDialog preview={preview} onComplete={onComplete} onCancel={jest.fn()} />)

    const dialog = screen.getByRole('dialog')
    fireEvent.keyDown(dialog, { key: 'Enter', metaKey: true })
    fireEvent.keyDown(dialog, { key: 'Enter', metaKey: true })

    expect(mockReadApiResult).toHaveBeenCalledTimes(1)
    resolveRequest({ progressJobId: 'job-1' })
    await waitFor(() => expect(onComplete).toHaveBeenCalledWith({ progressJobId: 'job-1' }))
  })
})
