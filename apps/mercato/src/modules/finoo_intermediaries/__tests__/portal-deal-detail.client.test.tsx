/**
 * @jest-environment jsdom
 */
import * as React from 'react'
import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import DealDetailPageClient from '../frontend/[orgSlug]/portal/intermediary/deals/[id]/page.client'

const translate = (_key: string, fallback: string) => fallback

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn() }),
}))

jest.mock('@open-mercato/shared/lib/i18n/context', () => ({
  useT: () => translate,
}))

jest.mock('@open-mercato/ui/backend/confirm-dialog', () => ({
  useConfirmDialog: () => ({ confirm: jest.fn(), ConfirmDialogElement: null }),
}))

jest.mock('@open-mercato/ui/backend/FlashMessages', () => ({ flash: jest.fn() }))

jest.mock('@open-mercato/ui/backend/injection/useGuardedMutation', () => ({
  useGuardedMutation: () => ({
    runMutation: jest.fn(async ({ operation }: { operation: () => Promise<unknown> }) => operation()),
  }),
}))

jest.mock('@open-mercato/ui/backend/utils/apiCall', () => ({
  readApiResultOrThrow: jest.fn(),
}))

jest.mock('@open-mercato/ui/backend/utils/optimisticLock', () => ({
  buildOptimisticLockHeader: () => ({ 'if-unmodified-since': '2026-08-18T00:00:00.000Z' }),
}))

const mockReadApiResult = readApiResultOrThrow as jest.MockedFunction<typeof readApiResultOrThrow>

describe('DealDetailPageClient', () => {
  beforeEach(() => {
    mockReadApiResult.mockReset()
    mockReadApiResult.mockImplementation(async (url) => {
      const requestUrl = String(url)
      if (requestUrl.endsWith('/activities?pageSize=50')) {
        return { items: [], nextCursor: null }
      }
      if (requestUrl.endsWith('/notes?pageSize=50')) {
        return { items: [], nextCursor: null }
      }
      return {
        deal: {
          id: 'deal-1',
          assignmentId: 'assignment-1',
          updatedAt: '2026-08-18T00:00:00.000Z',
          companyName: 'Example company',
          companyPhone: null,
          personMobile: null,
          personEmail: null,
          turnover: null,
          businessStartDate: null,
          arrears: null,
          industry: null,
          partnerStatus: 'new',
        },
      }
    })
  })

  it('does not advertise retry when no mutation has been blocked', async () => {
    render(<DealDetailPageClient orgSlug="test-org" dealId="deal-1" />)

    expect(await screen.findByText('No shared activities.')).toBeVisible()
    expect(screen.queryByText('A blocked operation can be retried after resolving the conflict.')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
  })
})
