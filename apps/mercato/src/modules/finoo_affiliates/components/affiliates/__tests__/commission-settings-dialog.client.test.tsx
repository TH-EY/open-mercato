/**
 * @jest-environment jsdom
 */
import * as React from 'react'
import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import CommissionSettingsDialog from '../commission-settings-dialog.client'

const mockRunMutation = jest.fn(
  async ({ operation }: { operation: () => Promise<unknown> }) => operation(),
)

jest.mock('@open-mercato/shared/lib/i18n/context', () => ({
  useT: () => (_key: string, fallback: string) => fallback,
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
  buildOptimisticLockHeader: () => ({ 'if-unmodified-since': '2026-08-13T00:00:00.000Z' }),
}))

const mockReadApiResult = readApiResultOrThrow as jest.MockedFunction<typeof readApiResultOrThrow>

function renderDialog(rateBps: number) {
  render(
    <CommissionSettingsDialog
      affiliate={{
        id: 'affiliate-1',
        email: 'affiliate@example.test',
        commissionMode: 'percentage',
        commissionRateBps: rateBps,
        commissionFixedAmount: null,
        updatedAt: '2026-08-13T00:00:00.000Z',
      }}
      onOpenChange={jest.fn()}
      onSaved={jest.fn()}
    />,
  )
}

describe('CommissionSettingsDialog', () => {
  beforeEach(() => {
    mockRunMutation.mockClear()
    mockReadApiResult.mockReset()
    mockReadApiResult.mockResolvedValue({
      id: 'affiliate-1',
      commissionMode: 'percentage',
      commissionRateBps: 7,
      commissionFixedAmount: null,
      updatedAt: '2026-08-14T00:00:00.000Z',
    })
  })

  it.each([
    ['0.07', 7],
    ['0.29', 29],
    ['1.15', 115],
  ])('submits %s as exact integer basis points', async (percentage, expectedRateBps) => {
    renderDialog(expectedRateBps)

    fireEvent.change(screen.getByLabelText('Percentage'), { target: { value: percentage } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(mockReadApiResult).toHaveBeenCalledTimes(1))
    const request = mockReadApiResult.mock.calls[0][1]
    expect(JSON.parse(String(request?.body))).toEqual(expect.objectContaining({
      commissionMode: 'percentage',
      commissionRateBps: expectedRateBps,
      commissionFixedAmount: null,
    }))
  })
})
