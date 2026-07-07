/** @jest-environment jsdom */

const mockConfirmDialog = jest.fn()
const mockApiCall = jest.fn()

jest.mock('@open-mercato/ui/backend/utils/apiCall', () => ({
  apiCall: (...args: unknown[]) => mockApiCall(...args),
}))

jest.mock('@open-mercato/ui/backend/FlashMessages', () => ({ flash: jest.fn() }))

jest.mock('@open-mercato/shared/lib/i18n/context', () => ({
  useT: () => (key: string, values?: Record<string, string>) => {
    if (key === 'workflows.instances.confirm.cancel') {
      return `Are you sure you want to cancel workflow '${values?.workflowId}'?`
    }
    if (key === 'workflows.instances.confirm.retry') {
      return `Are you sure you want to retry workflow '${values?.workflowId}'?`
    }
    return key
  },
}))

jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn() }) }))

jest.mock('next/link', () => ({ children, href }: { children: React.ReactNode; href: string }) => (
  <a href={href}>{children}</a>
))

jest.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: [], isLoading: false, error: null }),
  useQueryClient: () => ({ invalidateQueries: jest.fn() }),
}))

jest.mock('@open-mercato/ui/backend/confirm-dialog', () => ({
  useConfirmDialog: () => ({ confirm: mockConfirmDialog, ConfirmDialogElement: null }),
}))

let capturedColumns: Array<{ id?: string; cell?: (ctx: unknown) => React.ReactNode }> = []

jest.mock('@open-mercato/ui/backend/DataTable', () => ({
  DataTable: (props: { columns: Array<{ id?: string; cell?: (ctx: unknown) => React.ReactNode }> }) => {
    capturedColumns = props.columns
    return <div data-testid="data-table-mock" />
  },
}))

jest.mock('@open-mercato/ui/backend/RowActions', () => ({
  RowActions: ({ items }: { items: Array<{ id: string; label: string; onSelect?: () => void }> }) => (
    <div>
      {items.map((item) => (
        <button key={item.id} data-testid={`row-action-${item.id}`} onClick={() => item.onSelect?.()}>
          {item.label}
        </button>
      ))}
    </div>
  ),
}))

import * as React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import WorkflowInstancesListPage from '../page'

function buildInstance(overrides: Record<string, unknown> = {}) {
  return {
    id: 'instance-1',
    definitionId: 'definition-1',
    workflowId: 'webform_sales_flow',
    version: 1,
    status: 'RUNNING',
    currentStepId: 'start',
    correlationKey: null,
    startedAt: '2026-07-07T12:00:00.000Z',
    completedAt: null,
    cancelledAt: null,
    errorMessage: null,
    retryCount: 0,
    tenantId: 'tenant-1',
    organizationId: 'org-1',
    createdAt: '2026-07-07T12:00:00.000Z',
    updatedAt: '2026-07-07T12:00:00.000Z',
    ...overrides,
  }
}

function renderActionsCell(instance: Record<string, unknown>) {
  capturedColumns = []
  render(<WorkflowInstancesListPage />)
  const actionsColumn = capturedColumns.find((column) => column.id === 'actions')
  expect(actionsColumn?.cell).toBeTruthy()
  render(actionsColumn!.cell!({ row: { original: instance } }) as React.ReactElement)
}

describe('WorkflowInstancesListPage confirmations', () => {
  beforeEach(() => {
    mockConfirmDialog.mockReset().mockResolvedValue(false)
    mockApiCall.mockReset()
  })

  it('interpolates workflowId in the cancel confirmation', async () => {
    renderActionsCell(buildInstance({ status: 'RUNNING', workflowId: 'webform_sales_flow' }))

    fireEvent.click(screen.getByTestId('row-action-cancel'))

    await waitFor(() => expect(mockConfirmDialog).toHaveBeenCalledTimes(1))
    expect(mockConfirmDialog.mock.calls[0][0]).toMatchObject({
      title: "Are you sure you want to cancel workflow 'webform_sales_flow'?",
      variant: 'destructive',
    })
  })

  it('interpolates workflowId in the retry confirmation', async () => {
    renderActionsCell(buildInstance({ status: 'FAILED', workflowId: 'webform_sales_flow' }))

    fireEvent.click(screen.getByTestId('row-action-retry'))

    await waitFor(() => expect(mockConfirmDialog).toHaveBeenCalledTimes(1))
    expect(mockConfirmDialog.mock.calls[0][0]).toMatchObject({
      title: "Are you sure you want to retry workflow 'webform_sales_flow'?",
      variant: 'default',
    })
  })
})
