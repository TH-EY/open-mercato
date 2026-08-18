/**
 * @jest-environment jsdom
 */
import * as React from 'react'
import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import BulkAssignmentClient from '../components/bulk-assignments/bulk-assignment.client'

const mockRunMutation = jest.fn(
  async ({ operation }: { operation: () => Promise<unknown> }) => operation(),
)
const mockReadApiResult = readApiResultOrThrow as jest.MockedFunction<typeof readApiResultOrThrow>
const mockTranslate = (_key: string, fallback: string) => fallback

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn() }),
  useSearchParams: () => new URLSearchParams('dealIds=deal-1'),
}))

jest.mock('@open-mercato/shared/lib/i18n/context', () => ({
  useT: () => mockTranslate,
}))

jest.mock('@open-mercato/ui/backend/FlashMessages', () => ({ flash: jest.fn() }))
jest.mock('@open-mercato/ui/backend/conflicts', () => ({ surfaceRecordConflict: () => false }))
jest.mock('@open-mercato/ui/backend/confirm-dialog', () => ({
  useConfirmDialog: () => ({ confirm: jest.fn(async () => true), ConfirmDialogElement: null }),
}))
jest.mock('@open-mercato/ui/backend/injection/useAppEvent', () => ({ useAppEvent: jest.fn() }))
jest.mock('@open-mercato/ui/backend/progress/useProgressPoll', () => ({
  useProgressPoll: () => ({ recentlyCompleted: [] }),
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
jest.mock('@open-mercato/ui/primitives/select', () => ({
  Select: ({ value, onValueChange, children }: { value: string; onValueChange: (value: string) => void; children: React.ReactNode }) => (
    <select aria-label="Intermediary" value={value} onChange={(event) => onValueChange(event.target.value)}>{children}</select>
  ),
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => <option value={value}>{children}</option>,
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectValue: () => null,
}))

const availablePreflight = {
  deals: [{
    id: 'deal-1',
    state: 'available',
    name: 'Eligible Deal',
    updatedAt: '2026-08-18T10:00:00.000Z',
    blockedReason: null,
    assignment: null,
  }],
  intermediaries: [{ id: 'intermediary-1', displayName: 'Partner One', email: 'partner@example.test' }],
}

describe('BulkAssignmentClient', () => {
  beforeEach(() => {
    mockRunMutation.mockClear()
    mockReadApiResult.mockReset()
  })

  it('enqueues only one assignment while the first keyboard submission is pending', async () => {
    let resolvePost: (value: { progressJobId: string }) => void = () => undefined
    mockReadApiResult
      .mockResolvedValueOnce(availablePreflight)
      .mockReturnValueOnce(new Promise((resolve) => { resolvePost = resolve }))
    const { container } = render(<BulkAssignmentClient />)
    await screen.findByText('Eligible Deal')
    fireEvent.change(screen.getByRole('combobox', { name: 'Intermediary' }), { target: { value: 'intermediary-1' } })

    const page = container.firstElementChild as HTMLElement
    fireEvent.keyDown(page, { key: 'Enter', ctrlKey: true })
    fireEvent.keyDown(page, { key: 'Enter', ctrlKey: true })

    expect(mockReadApiResult).toHaveBeenCalledTimes(2)
    resolvePost({ progressJobId: 'job-1' })
    await screen.findByText('Bulk assignment started. Progress is visible in the top bar.')
  })

  it('renders a distinct explanation for every blocked Deal', async () => {
    mockReadApiResult.mockResolvedValueOnce({
      deals: [
        { ...availablePreflight.deals[0], blockedReason: 'ineligible_stage' },
        { id: 'deal-2', state: 'blocked', name: null, updatedAt: null, blockedReason: 'not_found', assignment: null },
      ],
      intermediaries: availablePreflight.intermediaries,
    })
    render(<BulkAssignmentClient />)

    expect(await screen.findByText('Move this Deal to Sent To Partners before assigning an intermediary.')).toBeVisible()
    expect(screen.getByText('This Deal is unavailable or outside your organization scope.')).toBeVisible()
  })
})
