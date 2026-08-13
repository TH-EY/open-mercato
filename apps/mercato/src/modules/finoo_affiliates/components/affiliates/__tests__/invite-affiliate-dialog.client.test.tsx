/**
 * @jest-environment jsdom
 */
import * as React from 'react'
import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import InviteAffiliateDialog from '../invite-affiliate-dialog.client'

const mockRunMutation = jest.fn(
  async ({ operation }: { operation: () => Promise<unknown> }) => operation(),
)

jest.mock('@open-mercato/shared/lib/i18n/context', () => ({
  useT: () => (_key: string, fallback: string) => fallback,
}))

jest.mock('@open-mercato/ui/backend/FlashMessages', () => ({ flash: jest.fn() }))

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

function renderDialog(onSynchronized = jest.fn()) {
  render(
    <InviteAffiliateDialog
      open
      onOpenChange={jest.fn()}
      affiliateRoleId="11111111-1111-4111-8111-111111111111"
      defaultDestinationReady
      onSynchronized={onSynchronized}
    />,
  )
  return onSynchronized
}

describe('InviteAffiliateDialog', () => {
  beforeEach(() => {
    mockRunMutation.mockClear()
    mockReadApiResult.mockReset()
  })

  it('sends the core invitation before reserving the FINOO membership', async () => {
    mockReadApiResult
      .mockResolvedValueOnce({ ok: true, invitation: { id: 'invite-1', email: 'affiliate@example.test' } })
      .mockResolvedValueOnce({
        ok: true,
        affiliate: { id: 'affiliate-1', code: 'ABC123', isActive: false, trackedUrl: '/tracked' },
      })
    const onSynchronized = renderDialog()

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'affiliate@example.test' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }))

    await waitFor(() => expect(mockReadApiResult).toHaveBeenCalledTimes(2))
    expect(mockReadApiResult.mock.calls[0][0]).toBe('/api/customer_accounts/admin/users-invite')
    expect(mockReadApiResult.mock.calls[1][0]).toBe('/api/finoo_affiliates/affiliates/ensure-invitation')
    expect(mockReadApiResult.mock.calls[0][1]).toEqual(expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        email: 'affiliate@example.test',
        roleIds: ['11111111-1111-4111-8111-111111111111'],
      }),
    }))
    expect(mockReadApiResult.mock.calls[1][1]).toEqual(expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ invitationId: 'invite-1' }),
    }))
    expect(await screen.findByText('ABC123')).toBeVisible()
    expect(onSynchronized).toHaveBeenCalledTimes(1)
  })

  it('retries FINOO synchronization without sending a second email', async () => {
    mockReadApiResult
      .mockResolvedValueOnce({ ok: true, invitation: { id: 'invite-2', email: 'affiliate@example.test' } })
      .mockRejectedValueOnce(new Error('sync failed'))
      .mockResolvedValueOnce({
        ok: true,
        affiliate: { id: 'affiliate-2', code: 'RETRY123', isActive: false, trackedUrl: '/tracked' },
      })
    renderDialog()

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'affiliate@example.test' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Retry sync' }))

    await waitFor(() => expect(mockReadApiResult).toHaveBeenCalledTimes(3))
    expect(mockReadApiResult.mock.calls.map(([url]) => url)).toEqual([
      '/api/customer_accounts/admin/users-invite',
      '/api/finoo_affiliates/affiliates/ensure-invitation',
      '/api/finoo_affiliates/affiliates/ensure-invitation',
    ])
    expect(await screen.findByText('RETRY123')).toBeVisible()
  })

  it('does not synchronize when the core invitation fails', async () => {
    mockReadApiResult.mockRejectedValueOnce(new Error('email failed'))
    renderDialog()

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'affiliate@example.test' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }))

    expect(await screen.findByText('The invitation email could not be sent. No affiliate was created.')).toBeVisible()
    expect(mockReadApiResult).toHaveBeenCalledTimes(1)
    expect(mockReadApiResult).toHaveBeenCalledWith(
      '/api/customer_accounts/admin/users-invite',
      expect.objectContaining({ method: 'POST' }),
    )
  })
})
