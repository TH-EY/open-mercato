/**
 * @jest-environment jsdom
 */
import * as React from 'react'
import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { apiCall, readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import AffiliatesClient from '../affiliates.client'

jest.mock('@open-mercato/shared/lib/i18n/context', () => ({
  useT: () => (_key: string, fallback: string) => fallback,
}))

jest.mock('@open-mercato/shared/lib/frontend/useOrganizationScope', () => ({
  useOrganizationScopeVersion: () => 1,
}))

jest.mock('@open-mercato/ui/backend/FlashMessages', () => ({ flash: jest.fn() }))

jest.mock('@open-mercato/ui/backend/DataTable', () => ({
  DataTable: (props: {
    actions?: React.ReactNode
    data: Array<{ email: string }>
    pagination?: { onPageChange: (page: number) => void }
  }) => (
    <div>
      {props.actions}
      {props.data.map((row) => <span key={row.email}>{row.email}</span>)}
      <button type="button" onClick={() => props.pagination?.onPageChange(2)}>Next page</button>
    </div>
  ),
}))

jest.mock('../invite-affiliate-dialog.client', () => ({
  __esModule: true,
  default: ({ open }: { open: boolean }) => open ? <div>Invite dialog open</div> : null,
}))

jest.mock('@open-mercato/ui/backend/utils/apiCall', () => ({
  apiCall: jest.fn(),
  readApiResultOrThrow: jest.fn(),
}))

const mockApiCall = apiCall as jest.MockedFunction<typeof apiCall>
const mockReadApiResult = readApiResultOrThrow as jest.MockedFunction<typeof readApiResultOrThrow>

function affiliateList() {
  return {
    items: [{
      id: 'affiliate-1',
      email: 'affiliate@example.test',
      firstName: 'Ada',
      lastName: 'Lovelace',
      code: 'AFFILIATE123',
      trackedUrl: 'https://example.test/tracked',
      relatedDeals: 2,
      state: 'active',
      updatedAt: '2026-08-13T00:00:00.000Z',
    }],
    total: 1,
    page: 1,
    pageSize: 25,
  }
}

describe('AffiliatesClient', () => {
  beforeEach(() => {
    mockApiCall.mockReset()
    mockReadApiResult.mockReset()
    mockReadApiResult.mockImplementation(async (url) => {
      if (url === '/api/finoo_affiliates/invite-options') {
        return {
          ok: true,
          affiliateRoleId: '11111111-1111-4111-8111-111111111111',
          defaultDestinationReady: true,
        } as never
      }
      return affiliateList() as never
    })
  })

  it('shows the invite action only when both required features are granted', async () => {
    mockApiCall.mockResolvedValue({
      ok: true,
      status: 200,
      result: { ok: true, granted: ['finoo_affiliates.manage', 'customer_accounts.invite'] },
    } as never)

    render(<AffiliatesClient />)

    fireEvent.click(await screen.findByRole('button', { name: 'Invite affiliate' }))
    expect(screen.getByText('Invite dialog open')).toBeVisible()
    expect(screen.getByText('affiliate@example.test')).toBeVisible()
  })

  it('keeps invitation controls hidden without the customer invite feature', async () => {
    mockApiCall.mockResolvedValue({
      ok: true,
      status: 200,
      result: { ok: false, granted: ['finoo_affiliates.manage'] },
    } as never)

    render(<AffiliatesClient />)

    await screen.findByText('affiliate@example.test')
    expect(screen.queryByRole('button', { name: 'Invite affiliate' })).not.toBeInTheDocument()
    expect(mockReadApiResult).not.toHaveBeenCalledWith('/api/finoo_affiliates/invite-options')
  })

  it('forwards pagination to the scoped list endpoint', async () => {
    mockApiCall.mockResolvedValue({
      ok: true,
      status: 200,
      result: { ok: false, granted: [] },
    } as never)

    render(<AffiliatesClient />)
    await screen.findByText('affiliate@example.test')

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    await waitFor(() => expect(mockReadApiResult).toHaveBeenCalledWith(
      expect.stringContaining('page=2'),
    ))
  })
})
