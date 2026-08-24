/**
 * @jest-environment jsdom
 */
import * as React from 'react'
import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import RetentionSettingsClient from '../backend/config/customers/retention/RetentionSettingsClient'

const mockReadApiResult = jest.fn()
const mockRunMutation = jest.fn(
  async ({ operation }: { operation: () => Promise<unknown> }) => operation(),
)
const mockConfirm = jest.fn(async () => true)
const mockSurfaceRecordConflict = jest.fn(() => false)
const mockWithScopedHeaders = jest.fn(
  async (_headers: Record<string, string>, operation: () => Promise<unknown>) => operation(),
)
const mockFlash = jest.fn()
const mockTranslate = (
  _key: string,
  fallback: string,
  variables?: Record<string, string | number>,
) => Object.entries(variables ?? {}).reduce(
  (message, [name, value]) => message.replaceAll(`{${name}}`, String(value)),
  fallback,
)

jest.mock('@open-mercato/shared/lib/i18n/context', () => ({
  useT: () => mockTranslate,
}))
jest.mock('@open-mercato/shared/lib/frontend/useOrganizationScope', () => ({
  useOrganizationScopeVersion: () => 1,
}))
jest.mock('@open-mercato/ui/backend/FlashMessages', () => ({
  flash: (...args: unknown[]) => mockFlash(...args),
}))
jest.mock('@open-mercato/ui/backend/confirm-dialog', () => ({
  useConfirmDialog: () => ({ confirm: mockConfirm, ConfirmDialogElement: null }),
}))
jest.mock('@open-mercato/ui/backend/conflicts', () => ({
  surfaceRecordConflict: (...args: unknown[]) => mockSurfaceRecordConflict(...args),
}))
jest.mock('@open-mercato/ui/backend/injection/useGuardedMutation', () => ({
  useGuardedMutation: () => ({
    runMutation: mockRunMutation,
    retryLastMutation: jest.fn(async () => false),
  }),
}))
jest.mock('@open-mercato/ui/backend/utils/apiCall', () => ({
  readApiResultOrThrow: (...args: unknown[]) => mockReadApiResult(...args),
  withScopedApiRequestHeaders: (
    headers: Record<string, string>,
    operation: () => Promise<unknown>,
  ) => mockWithScopedHeaders(headers, operation),
}))

describe('RetentionSettingsClient', () => {
  beforeEach(() => {
    mockReadApiResult.mockReset()
    mockRunMutation.mockClear()
    mockConfirm.mockClear()
    mockConfirm.mockResolvedValue(true)
    mockSurfaceRecordConflict.mockClear()
    mockSurfaceRecordConflict.mockReturnValue(false)
    mockWithScopedHeaders.mockClear()
    mockFlash.mockClear()
  })

  it('requires a preview on first enable and confirms all impact counts before saving', async () => {
    mockReadApiResult
      .mockResolvedValueOnce({ setting: { inactivityWindowDays: null }, updatedAt: '2026-08-24T10:00:00.000Z' })
      .mockResolvedValueOnce({
        token: 'preview-token',
        expiresAt: '2026-08-24T10:10:00.000Z',
        totalEligible: 42,
        newlyExpired: 9,
        alreadyExpired: 3,
        updatedAt: '2026-08-24T10:00:30.000Z',
      })
      .mockResolvedValueOnce({
        setting: { inactivityWindowDays: 30 },
        updatedAt: '2026-08-24T10:01:00.000Z',
        progressJobId: 'job-1',
      })

    render(<RetentionSettingsClient />)

    const enabledSwitch = await screen.findByRole('switch', { name: 'Enable retention expiry' })
    fireEvent.click(enabledSwitch)
    fireEvent.change(screen.getByRole('spinbutton', { name: /Inactivity period in days/ }), {
      target: { value: '30' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(mockConfirm).toHaveBeenCalledTimes(1))
    expect(mockConfirm).toHaveBeenCalledWith(expect.objectContaining({
      text: 'Eligible people: 42. Newly expired: 9. Already expired: 3.',
    }))
    await waitFor(() => expect(mockReadApiResult).toHaveBeenCalledTimes(3))

    expect(mockReadApiResult.mock.calls[1][0]).toBe('/api/finoo_customer_retention/settings/preview')
    expect(JSON.parse(mockReadApiResult.mock.calls[1][1].body)).toEqual({ inactivityWindowDays: 30 })
    expect(mockReadApiResult.mock.calls[2][0]).toBe('/api/finoo_customer_retention/settings')
    expect(JSON.parse(mockReadApiResult.mock.calls[2][1].body)).toEqual({
      inactivityWindowDays: 30,
      previewToken: 'preview-token',
    })
    expect(mockWithScopedHeaders).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        'x-om-ext-optimistic-lock-expected-updated-at': '2026-08-24T10:00:00.000Z',
      }),
      expect.any(Function),
    )
    expect(mockWithScopedHeaders).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        'x-om-ext-optimistic-lock-expected-updated-at': '2026-08-24T10:00:30.000Z',
      }),
      expect.any(Function),
    )
    expect(await screen.findByText('Reconciliation has started. Progress is visible in the top bar.')).toBeVisible()
  })

  it('uses the version returned by a cancelled preview when previewing again', async () => {
    mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    mockReadApiResult
      .mockResolvedValueOnce({ inactivityWindowDays: null, updatedAt: '2026-08-24T10:00:00.000Z' })
      .mockResolvedValueOnce({
        token: 'cancelled-preview-token',
        expiresAt: '2026-08-24T10:10:00.000Z',
        totalEligible: 1,
        newlyExpired: 1,
        alreadyExpired: 0,
        updatedAt: '2026-08-24T10:00:30.000Z',
      })
      .mockResolvedValueOnce({
        token: 'accepted-preview-token',
        expiresAt: '2026-08-24T10:11:00.000Z',
        totalEligible: 1,
        newlyExpired: 1,
        alreadyExpired: 0,
        updatedAt: '2026-08-24T10:01:00.000Z',
      })
      .mockResolvedValueOnce({
        inactivityWindowDays: 30,
        updatedAt: '2026-08-24T10:02:00.000Z',
        progressJobId: 'job-after-cancel',
      })

    render(<RetentionSettingsClient />)

    fireEvent.click(await screen.findByRole('switch', { name: 'Enable retention expiry' }))
    fireEvent.change(screen.getByRole('spinbutton', { name: /Inactivity period in days/ }), {
      target: { value: '30' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(mockConfirm).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(mockReadApiResult).toHaveBeenCalledTimes(4))

    expect(mockWithScopedHeaders).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        'x-om-ext-optimistic-lock-expected-updated-at': '2026-08-24T10:00:30.000Z',
      }),
      expect.any(Function),
    )
    expect(mockWithScopedHeaders).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        'x-om-ext-optimistic-lock-expected-updated-at': '2026-08-24T10:01:00.000Z',
      }),
      expect.any(Function),
    )
  })

  it('saves an increased period directly from the keyboard shortcut without a preview', async () => {
    mockReadApiResult
      .mockResolvedValueOnce({ inactivityWindowDays: 30, updatedAt: '2026-08-24T10:00:00.000Z' })
      .mockResolvedValueOnce({ inactivityWindowDays: 60, updatedAt: '2026-08-24T10:01:00.000Z' })

    const { container } = render(<RetentionSettingsClient />)

    const input = await screen.findByRole('spinbutton', { name: /Inactivity period in days/ })
    fireEvent.change(input, { target: { value: '60' } })
    fireEvent.keyDown(container.querySelector('form')!, { key: 'Enter', ctrlKey: true })

    await waitFor(() => expect(mockReadApiResult).toHaveBeenCalledTimes(2))
    expect(mockConfirm).not.toHaveBeenCalled()
    expect(JSON.parse(mockReadApiResult.mock.calls[1][1].body)).toEqual({
      inactivityWindowDays: 60,
    })
  })

  it('routes save conflicts to the unified conflict surface', async () => {
    const conflict = new Error('conflict')
    mockReadApiResult
      .mockResolvedValueOnce({ inactivityWindowDays: 30, updatedAt: '2026-08-24T10:00:00.000Z' })
      .mockRejectedValueOnce(conflict)
    mockSurfaceRecordConflict.mockReturnValue(true)

    render(<RetentionSettingsClient />)

    fireEvent.change(await screen.findByRole('spinbutton', { name: /Inactivity period in days/ }), {
      target: { value: '60' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(mockSurfaceRecordConflict).toHaveBeenCalledWith(
      conflict,
      mockTranslate,
      expect.objectContaining({ onRefresh: expect.any(Function) }),
    ))
    expect(mockFlash).not.toHaveBeenCalledWith(
      'Unable to save customer retention settings.',
      'error',
    )
  })

  it('refreshes a stale preview once and reopens confirmation with fresh counts', async () => {
    const staleError = Object.assign(new Error('stale'), {
      status: 409,
      code: 'preview_stale',
    })
    mockReadApiResult
      .mockResolvedValueOnce({ inactivityWindowDays: null, updatedAt: '2026-08-24T10:00:00.000Z' })
      .mockResolvedValueOnce({
        token: 'preview-token-1',
        expiresAt: '2026-08-24T10:10:00.000Z',
        totalEligible: 42,
        newlyExpired: 9,
        alreadyExpired: 3,
        updatedAt: '2026-08-24T10:00:00.000Z',
      })
      .mockRejectedValueOnce(staleError)
      .mockResolvedValueOnce({ inactivityWindowDays: null, updatedAt: '2026-08-24T10:02:00.000Z' })
      .mockResolvedValueOnce({
        token: 'preview-token-2',
        expiresAt: '2026-08-24T10:12:00.000Z',
        totalEligible: 44,
        newlyExpired: 11,
        alreadyExpired: 4,
        updatedAt: '2026-08-24T10:02:00.000Z',
      })
      .mockResolvedValueOnce({
        inactivityWindowDays: 30,
        updatedAt: '2026-08-24T10:03:00.000Z',
        progressJobId: 'job-2',
      })

    render(<RetentionSettingsClient />)

    fireEvent.click(await screen.findByRole('switch', { name: 'Enable retention expiry' }))
    fireEvent.change(screen.getByRole('spinbutton', { name: /Inactivity period in days/ }), {
      target: { value: '30' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(mockConfirm).toHaveBeenCalledTimes(2))
    expect(mockConfirm).toHaveBeenNthCalledWith(1, expect.objectContaining({
      text: 'Eligible people: 42. Newly expired: 9. Already expired: 3.',
    }))
    expect(mockConfirm).toHaveBeenNthCalledWith(2, expect.objectContaining({
      text: 'Eligible people: 44. Newly expired: 11. Already expired: 4.',
    }))
    await waitFor(() => expect(mockReadApiResult).toHaveBeenCalledTimes(6))
    expect(JSON.parse(mockReadApiResult.mock.calls[4][1].body)).toEqual({
      inactivityWindowDays: 30,
    })
    expect(JSON.parse(mockReadApiResult.mock.calls[5][1].body)).toEqual({
      inactivityWindowDays: 30,
      previewToken: 'preview-token-2',
    })
    expect(mockWithScopedHeaders).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        'x-om-ext-optimistic-lock-expected-updated-at': '2026-08-24T10:02:00.000Z',
      }),
      expect.any(Function),
    )
  })

  it('stops after a second preview race and surfaces a stale error', async () => {
    const staleError = Object.assign(new Error('stale'), {
      status: 409,
      code: 'preview_stale',
    })
    mockReadApiResult
      .mockResolvedValueOnce({ inactivityWindowDays: null, updatedAt: '2026-08-24T10:00:00.000Z' })
      .mockResolvedValueOnce({
        token: 'preview-token-1',
        expiresAt: '2026-08-24T10:10:00.000Z',
        totalEligible: 42,
        newlyExpired: 9,
        alreadyExpired: 3,
        updatedAt: '2026-08-24T10:00:00.000Z',
      })
      .mockRejectedValueOnce(staleError)
      .mockResolvedValueOnce({ inactivityWindowDays: null, updatedAt: '2026-08-24T10:02:00.000Z' })
      .mockResolvedValueOnce({
        token: 'preview-token-2',
        expiresAt: '2026-08-24T10:12:00.000Z',
        totalEligible: 44,
        newlyExpired: 11,
        alreadyExpired: 4,
        updatedAt: '2026-08-24T10:02:00.000Z',
      })
      .mockRejectedValueOnce(staleError)

    render(<RetentionSettingsClient />)

    fireEvent.click(await screen.findByRole('switch', { name: 'Enable retention expiry' }))
    fireEvent.change(screen.getByRole('spinbutton', { name: /Inactivity period in days/ }), {
      target: { value: '30' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText(
      'The retention preview changed again. Review the latest data and try once more.',
    )).toBeVisible()
    expect(mockConfirm).toHaveBeenCalledTimes(2)
    expect(mockReadApiResult).toHaveBeenCalledTimes(6)
  })
})
