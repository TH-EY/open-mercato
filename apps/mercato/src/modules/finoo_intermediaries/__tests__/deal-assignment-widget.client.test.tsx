/**
 * @jest-environment jsdom
 */
import * as React from 'react'
import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import DealAssignmentWidget from '../widgets/injection/deal-assignment/widget.client'

const mockRunMutation = jest.fn(
  async ({ operation }: { operation: () => Promise<unknown> }) => operation(),
)
const translate = (_key: string, fallback: string) => fallback

jest.mock('@open-mercato/shared/lib/i18n/context', () => ({
  useT: () => translate,
}))

jest.mock('@open-mercato/ui/backend/BackendChromeProvider', () => ({
  useBackendChrome: () => ({
    isReady: true,
    payload: { grantedFeatures: ['finoo_intermediaries.manage'] },
  }),
}))

jest.mock('@open-mercato/ui/backend/confirm-dialog', () => ({
  useConfirmDialog: () => ({ confirm: jest.fn(), ConfirmDialogElement: null }),
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

jest.mock('@open-mercato/ui/backend/utils/optimisticLock', () => ({
  buildOptimisticLockHeader: () => ({ 'if-unmodified-since': '2026-08-17T00:00:00.000Z' }),
}))

const mockReadApiResult = readApiResultOrThrow as jest.MockedFunction<typeof readApiResultOrThrow>

const existingAssignment = {
  id: 'assignment-1',
  dealId: 'deal-1',
  intermediaryCustomerUserId: 'intermediary-1',
  intermediaryRoleId: 'role-1',
  eligibleStageId: 'stage-1',
  partnerStatus: 'new' as const,
  statusUpdatedAt: null,
  createdAt: '2026-08-17T00:00:00.000Z',
  updatedAt: '2026-08-17T00:00:00.000Z',
}

function mockWidgetLoad(
  canManage: boolean,
  assignment: typeof existingAssignment | null = null,
  notes: Array<{
    id: string
    authorCustomerUserId: string
    body: string
    createdAt: string
    updatedAt: string
  }> = [],
) {
  mockReadApiResult.mockImplementation(async (url) => {
    if (String(url).includes('/admin/assignments?')) {
      return {
        assignment,
        eligibility: { canManage, reason: canManage ? null : 'ineligible_stage' },
        notes,
        notesNextCursor: null,
      }
    }
    return {
      items: [{ id: 'intermediary-1', displayName: 'Partner One', email: 'partner@example.test' }],
    }
  })
}

describe('DealAssignmentWidget', () => {
  beforeEach(() => {
    mockRunMutation.mockClear()
    mockReadApiResult.mockReset()
  })

  it('disables intermediary controls outside Sent To Partners and explains how to unlock them', async () => {
    mockWidgetLoad(false)

    render(<DealAssignmentWidget context={{ dealId: 'deal-1' }} />)

    expect(await screen.findByText('Move the deal to Sent To Partners to manage its intermediary assignment.')).toBeVisible()
    expect(screen.getByRole('combobox')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDisabled()
  })

  it('keeps the intermediary selector enabled when the Deal is eligible', async () => {
    mockWidgetLoad(true)

    render(<DealAssignmentWidget context={{ dealId: 'deal-1' }} />)

    expect(await screen.findByRole('combobox')).toBeEnabled()
    expect(screen.queryByText('Move the deal to Sent To Partners to manage its intermediary assignment.')).not.toBeInTheDocument()
  })

  it('keeps an existing assignment readable but blocks its mutations after the Deal leaves the stage', async () => {
    mockWidgetLoad(false, existingAssignment)

    render(<DealAssignmentWidget context={{ dealId: 'deal-1' }} />)

    expect(await screen.findByText('new')).toBeVisible()
    expect(screen.getByRole('combobox')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Unassign' })).toBeDisabled()
  })

  it('uses intermediary terminology and hides technical note author identifiers', async () => {
    const authorCustomerUserId = 'adf72801-1dfd-45b2-a46e-ab0a24e4e6cc'
    const updatedAt = '2026-08-18T09:16:59.000Z'
    mockWidgetLoad(true, existingAssignment, [{
      id: 'note-1',
      authorCustomerUserId,
      body: 'Visible note',
      createdAt: updatedAt,
      updatedAt,
    }])

    render(<DealAssignmentWidget context={{ dealId: 'deal-1' }} />)

    expect(await screen.findByText('Intermediary status')).toBeVisible()
    expect(screen.getByText('Visible note')).toBeVisible()
    expect(screen.getByText(new Date(updatedAt).toLocaleString())).toBeVisible()
    expect(screen.queryByText(authorCustomerUserId, { exact: false })).not.toBeInTheDocument()
  })
})
