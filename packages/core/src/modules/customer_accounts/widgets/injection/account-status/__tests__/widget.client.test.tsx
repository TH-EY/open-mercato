/**
 * @jest-environment jsdom
 *
 * Regression coverage for the account-status invite form:
 * - it must not submit a parent CrudForm when embedded in one;
 * - it must route invitation writes through useGuardedMutation.
 */
import * as React from 'react'
import '@testing-library/jest-dom'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import AccountStatusWidget from '../widget.client'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'

const flashMock = jest.fn()
const mockRunMutation = jest.fn(
  async ({ operation }: { operation: () => Promise<unknown> }) => operation(),
)

jest.mock('@open-mercato/shared/lib/i18n/context', () => ({
  useT: () => (_key: string, fallback: string) => fallback || _key,
}))

jest.mock('@open-mercato/ui/backend/FlashMessages', () => ({
  flash: (...args: unknown[]) => flashMock(...args),
}))

jest.mock('@open-mercato/ui/backend/injection/useGuardedMutation', () => ({
  useGuardedMutation: jest.fn(() => ({ runMutation: mockRunMutation })),
}))

jest.mock('@open-mercato/ui/backend/utils/apiCall', () => ({
  apiCall: jest.fn(),
}))

jest.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: null, isLoading: false }),
  useQueryClient: () => ({ invalidateQueries: jest.fn() }),
}))

const mockApiCall = apiCall as jest.MockedFunction<typeof apiCall>

describe('customer account status widget invite form', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockRunMutation.mockClear()
    mockApiCall.mockReset()
    mockApiCall.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url.startsWith('/api/customer_accounts/admin/users?')) {
        return { ok: true, status: 200, result: { items: [] } } as never
      }
      if (url === '/api/customers/people/person-1') {
        return {
          ok: true,
          status: 200,
          result: {
            person: { primaryEmail: 'buyer@example.test', displayName: 'Buyer Contact' },
            profile: { firstName: 'Buyer', lastName: 'Contact' },
          },
        } as never
      }
      if (typeof url === 'string' && url.includes('/api/customers/people/')) {
        return { ok: true, status: 200, result: { person: null, profile: null } } as never
      }
      if (typeof url === 'string' && url.includes('/api/customer_accounts/admin/roles')) {
        return {
          ok: true,
          status: 200,
          result: { items: [{ id: '00000000-0000-4000-8000-000000000001', name: 'Viewer' }] },
        } as never
      }
      if (url === '/api/customer_accounts/admin/users-invite' && options?.method === 'POST') {
        return { ok: true, status: 200, result: { ok: true } } as never
      }
      return { ok: false, status: 500, result: { error: 'unexpected call' } } as never
    })
  })

  it('sends an invite from inside a parent CrudForm without submitting the parent form', async () => {
    const parentSubmit = jest.fn((event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault()
    })

    const { container } = render(
      <form onSubmit={parentSubmit}>
        <AccountStatusWidget context={{ recordId: 'person-1' }} />
      </form>,
    )

    await screen.findByRole('button', { name: 'Invite to Portal' })
    expect(container.querySelectorAll('form')).toHaveLength(1)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Invite to Portal' }))
    })

    await screen.findByDisplayValue('buyer@example.test')
    await screen.findByRole('button', { name: 'Viewer' })
    expect(container.querySelectorAll('form')).toHaveLength(1)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Viewer' }))
    })

    const sendButton = screen.getByRole('button', { name: 'Send Invitation' })
    expect(sendButton).not.toBeDisabled()

    await act(async () => {
      fireEvent.click(sendButton)
    })

    await waitFor(() => {
      expect(mockRunMutation).toHaveBeenCalledTimes(1)
      expect(mockApiCall).toHaveBeenCalledWith(
        '/api/customer_accounts/admin/users-invite',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            email: 'buyer@example.test',
            roleIds: ['00000000-0000-4000-8000-000000000001'],
            displayName: 'Buyer Contact',
            customerEntityId: 'person-1',
          }),
        }),
      )
    })
    expect(parentSubmit).not.toHaveBeenCalled()
    expect(flashMock).toHaveBeenCalledWith('Invitation sent successfully', 'success')
  })

  it('routes the invitation POST through useGuardedMutation.runMutation', async () => {
    render(<AccountStatusWidget context={{ recordId: 'person-entity-1' }} />)

    fireEvent.click(await screen.findByRole('button', { name: /invite to portal/i }))
    fireEvent.change(await screen.findByLabelText(/email/i), {
      target: { value: 'buyer@example.com' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Viewer' }))
    fireEvent.click(await screen.findByRole('button', { name: /send invitation/i }))

    await waitFor(() => {
      expect(mockRunMutation).toHaveBeenCalledTimes(1)
    })

    const runArgs = mockRunMutation.mock.calls[0][0] as {
      context: { entityType: string }
      mutationPayload: Record<string, unknown>
    }
    expect(runArgs.context.entityType).toBe('customer_accounts:user')
    expect(runArgs.mutationPayload.customerEntityId).toBe('person-entity-1')

    await waitFor(() => {
      const inviteCall = mockApiCall.mock.calls.find(
        ([url]) => typeof url === 'string' && url.includes('/api/customer_accounts/admin/users-invite'),
      )
      expect(inviteCall).toBeTruthy()
      expect((inviteCall?.[1] as RequestInit | undefined)?.method).toBe('POST')
    })
  })
})
