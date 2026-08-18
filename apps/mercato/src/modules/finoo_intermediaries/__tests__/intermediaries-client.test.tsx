/**
 * @jest-environment jsdom
 */
import * as React from 'react'
import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import IntermediariesClient from '../components/intermediaries/intermediaries.client'

const translate = (key: string) => ({
  'finoo_intermediaries.directory.title': 'Intermediaries',
  'finoo_intermediaries.directory.actions.invite': 'Invite intermediary',
}[key] ?? key)

jest.mock('@open-mercato/shared/lib/i18n/context', () => ({
  useT: () => translate,
}))

jest.mock('@open-mercato/shared/lib/frontend/useOrganizationScope', () => ({
  useOrganizationScopeVersion: () => 1,
}))

jest.mock('@open-mercato/ui/backend/BackendChromeProvider', () => ({
  useBackendChrome: () => ({
    isReady: true,
    payload: {
      grantedFeatures: [
        'finoo_intermediaries.manage',
        'customer_accounts.invite',
        'customer_accounts.manage',
      ],
    },
  }),
}))

jest.mock('@open-mercato/ui/backend/Page', () => ({
  PageBody: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
  PageHeader: () => <div>Standalone page header</div>,
}))

jest.mock('@open-mercato/ui/backend/DataTable', () => ({
  DataTable: (props: {
    title?: React.ReactNode
    actions?: React.ReactNode
    isLoading?: boolean
  }) => (
    <section data-testid="canonical-data-table">
      <h1 data-testid="data-table-title">{props.title}</h1>
      {props.actions}
      {props.isLoading ? <div>Loading table</div> : null}
    </section>
  ),
}))

jest.mock('@open-mercato/ui/backend/utils/apiCall', () => ({
  apiCall: jest.fn(),
}))

jest.mock('../components/intermediaries/intermediary-dialog.client', () => ({
  IntermediaryDialog: ({ open, mode }: { open: boolean; mode: string }) => open
    ? <div>{mode === 'invite' ? 'Invite dialog open' : 'Edit dialog open'}</div>
    : null,
}))

jest.mock('../components/intermediaries/intermediary-row-actions.client', () => ({
  useIntermediaryRowActions: () => ({
    getRowActions: () => [],
    ConfirmDialogElement: null,
  }),
}))

const mockApiCall = apiCall as jest.MockedFunction<typeof apiCall>

describe('IntermediariesClient', () => {
  beforeEach(() => {
    mockApiCall.mockReset()
    mockApiCall.mockReturnValue(new Promise(() => {}) as never)
  })

  it('uses the DataTable header for the page title and invite action during loading', () => {
    render(<IntermediariesClient />)

    expect(screen.getByTestId('canonical-data-table')).toBeVisible()
    expect(screen.getByTestId('data-table-title')).toHaveTextContent('Intermediaries')
    expect(screen.getByText('Loading table')).toBeVisible()
    expect(screen.queryByText('Standalone page header')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Invite intermediary' }))
    expect(screen.getByText('Invite dialog open')).toBeVisible()
  })
})
