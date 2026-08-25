/**
 * @jest-environment jsdom
 */
import * as React from 'react'
import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'
import CompletenessFilterWidget from '../widgets/injection/completeness-filter/widget.client'

jest.mock('@open-mercato/shared/lib/i18n/context', () => ({
  useT: () => (key: string) => ({
    'finoo_identities.filter.label': 'Identity data completeness',
    'finoo_identities.filter.all': 'All identity statuses',
    'finoo_identities.aggregate.complete': 'Complete',
    'finoo_identities.aggregate.incomplete': 'Incomplete',
  }[key] ?? key),
}))

jest.mock('@open-mercato/ui/primitives/select', () => ({
  Select: ({ value, onValueChange, children }: { value: string; onValueChange: (value: string) => void; children: React.ReactNode }) => (
    <select aria-label="Identity data completeness" value={value} onChange={(event) => onValueChange(event.target.value)}>
      {children}
    </select>
  ),
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => <option value={value}>{children}</option>,
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectValue: () => null,
}))

describe('CompletenessFilterWidget', () => {
  it('renders the controlled state and forwards complete/incomplete/all changes', () => {
    const onQueryFilterChange = jest.fn()
    render(<CompletenessFilterWidget context={{
      queryFilters: { finooIdentityComplete: 'false' },
      onQueryFilterChange,
    }} />)

    const select = screen.getByRole('combobox', { name: 'Identity data completeness' })
    expect(select).toHaveValue('false')

    fireEvent.change(select, { target: { value: 'true' } })
    expect(onQueryFilterChange).toHaveBeenLastCalledWith('finooIdentityComplete', 'true')

    fireEvent.change(select, { target: { value: 'all' } })
    expect(onQueryFilterChange).toHaveBeenLastCalledWith('finooIdentityComplete', null)
  })

  it('stays hidden when the host does not provide query-filter control', () => {
    const { container } = render(<CompletenessFilterWidget context={{}} />)

    expect(container).toBeEmptyDOMElement()
  })
})
