/**
 * @jest-environment jsdom
 */
import * as React from 'react'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { renderWithProviders } from '@open-mercato/shared/lib/testing/renderWithProviders'
import { DealPeopleSection } from '../DealPeopleSection'
import type { LinkedPersonSummary } from '../LinkedPeopleSection'

const readApiResultOrThrowMock = jest.fn()

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn() }),
}))

jest.mock('@open-mercato/ui/backend/utils/apiCall', () => ({
  apiCallOrThrow: jest.fn(),
  readApiResultOrThrow: (...args: unknown[]) => readApiResultOrThrowMock(...args),
}))

jest.mock('../PersonCard', () => ({
  PersonCard: ({
    person,
    onUnlink,
  }: {
    person: LinkedPersonSummary
    onUnlink: (personId: string) => void
  }) => (
    <div>
      <span>{person.displayName}</span>
      <button type="button" onClick={() => onUnlink(person.id)}>
        {`unlink-${person.id}`}
      </button>
    </div>
  ),
}))

describe('DealPeopleSection', () => {
  const emptyState = {
    title: 'Link the people involved',
    actionLabel: 'Link existing person',
  }

  const linkedPeople: LinkedPersonSummary[] = [
    { id: 'person-1', displayName: 'Ada Lovelace', jobTitle: 'VP Partnerships' },
    { id: 'person-2', displayName: 'Grace Hopper', jobTitle: 'Procurement lead' },
  ]

  function renderSection(onSaveSelection: (next: string[]) => Promise<void>) {
    return renderWithProviders(
      <DealPeopleSection
        dealId="deal-1"
        dealName="Expansion renewal"
        selectedIds={['person-1', 'person-2']}
        onSaveSelection={onSaveSelection}
        emptyLabel="No people linked to this deal yet."
        emptyState={emptyState}
      />,
    )
  }

  beforeEach(() => {
    readApiResultOrThrowMock.mockReset()
    readApiResultOrThrowMock.mockImplementation(async () => ({
      items: linkedPeople,
      page: 1,
      total: linkedPeople.length,
      totalPages: 1,
    }))
  })

  async function waitForInitialLoad() {
    await waitFor(() => {
      expect(screen.queryByText(/Loading people/)).not.toBeInTheDocument()
    })
  }

  it('loads linked people from the deal endpoint', async () => {
    renderSection(jest.fn(async () => {}))
    await waitForInitialLoad()

    expect(readApiResultOrThrowMock).toHaveBeenCalledWith(
      '/api/customers/deals/deal-1/people?page=1&pageSize=20&sort=name-asc',
      undefined,
      expect.any(Object),
    )
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument()
    expect(screen.getByText('Grace Hopper')).toBeInTheDocument()
  })

  it('unlinks a person by saving the remaining selection', async () => {
    const onSaveSelection = jest.fn(async () => {})
    renderSection(onSaveSelection)
    await waitForInitialLoad()

    fireEvent.click(screen.getByRole('button', { name: 'unlink-person-1' }))

    await waitFor(() => {
      expect(onSaveSelection).toHaveBeenCalledWith(['person-2'])
    })
  })

  it('forwards the search query and sort mode to the deal endpoint', async () => {
    renderSection(jest.fn(async () => {}))
    await waitForInitialLoad()

    fireEvent.change(screen.getByPlaceholderText('Search by name, role, email...'), {
      target: { value: 'grace' },
    })

    await waitFor(() => {
      expect(readApiResultOrThrowMock).toHaveBeenCalledWith(
        '/api/customers/deals/deal-1/people?page=1&pageSize=20&sort=name-asc&search=grace',
        undefined,
        expect.any(Object),
      )
    })

    fireEvent.change(screen.getByDisplayValue('Sort: Name A-Z'), {
      target: { value: 'recent' },
    })

    await waitFor(() => {
      expect(readApiResultOrThrowMock).toHaveBeenCalledWith(
        '/api/customers/deals/deal-1/people?page=1&pageSize=20&sort=recent&search=grace',
        undefined,
        expect.any(Object),
      )
    })
  })

  it('toggles the filter controls off and on', async () => {
    renderSection(jest.fn(async () => {}))
    await waitForInitialLoad()

    expect(screen.getByPlaceholderText('Search by name, role, email...')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Filters/ }))

    expect(screen.queryByPlaceholderText('Search by name, role, email...')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Filters/ }))

    expect(screen.getByPlaceholderText('Search by name, role, email...')).toBeInTheDocument()
  })

  it('renders the empty state with a link action when nothing is linked', async () => {
    readApiResultOrThrowMock.mockImplementation(async () => ({
      items: [],
      page: 1,
      total: 0,
      totalPages: 1,
    }))

    renderWithProviders(
      <DealPeopleSection
        dealId="deal-1"
        selectedIds={[]}
        onSaveSelection={jest.fn(async () => {})}
        emptyLabel="No people linked to this deal yet."
        emptyState={emptyState}
      />,
    )

    await waitForInitialLoad()

    expect(screen.getByText('Link the people involved')).toBeInTheDocument()
    expect(screen.getByText('No people linked to this deal yet.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Link existing person/ })).toBeInTheDocument()
  })
})
