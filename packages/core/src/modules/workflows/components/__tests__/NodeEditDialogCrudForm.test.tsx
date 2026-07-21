/** @jest-environment jsdom */
import * as React from 'react'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { renderWithProviders } from '@open-mercato/shared/lib/testing/renderWithProviders'
import { NodeEditDialogCrudForm } from '../NodeEditDialogCrudForm'

const mockApiCall = jest.fn()

jest.mock('@open-mercato/ui/backend/utils/apiCall', () => ({
  apiCall: (...args: unknown[]) => mockApiCall(...args),
}))

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), refresh: jest.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}))

if (typeof window !== 'undefined') {
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false
  if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = () => undefined
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => undefined
  if (!window.ResizeObserver) {
    window.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as any
  }
}

describe('NodeEditDialogCrudForm', () => {
  beforeEach(() => {
    mockApiCall.mockResolvedValue({
      ok: true,
      result: {
        data: [
          {
            id: 'sales.quote.status_changed',
            label: 'Quote Status Changed',
            category: 'lifecycle',
            module: 'sales',
            entity: 'quote',
          },
        ],
        total: 1,
      },
    })
  })

  it('selects and saves a declared signal from the event catalog', async () => {
    const onSave = jest.fn()

    renderWithProviders(
      <NodeEditDialogCrudForm
        node={{
          id: 'wait_for_quote_status',
          type: 'waitForSignal',
          data: { label: 'Wait for quote status', signalConfig: {} },
        } as any}
        isOpen
        onClose={jest.fn()}
        onSave={onSave}
      />,
    )

    fireEvent.focus(await screen.findByPlaceholderText('workflows.form.placeholders.signalName'))
    fireEvent.click(await screen.findByText('Quote Status Changed'))
    fireEvent.click(screen.getByRole('button', { name: 'Save Step' }))

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith(
        'wait_for_quote_status',
        expect.objectContaining({
          signalConfig: expect.objectContaining({
            signalName: 'sales.quote.status_changed',
          }),
        }),
      )
    })
  })

  it('saves a newly typed custom signal without waiting for delayed blur confirmation', async () => {
    const onSave = jest.fn()

    renderWithProviders(
      <NodeEditDialogCrudForm
        node={{
          id: 'wait_for_custom_signal',
          type: 'waitForSignal',
          data: { label: 'Wait for custom signal', signalConfig: {} },
        } as any}
        isOpen
        onClose={jest.fn()}
        onSave={onSave}
      />,
    )

    const input = await screen.findByPlaceholderText('workflows.form.placeholders.signalName')
    fireEvent.change(input, { target: { value: 'custom.quote.approved' } })
    fireEvent.blur(input)
    fireEvent.click(screen.getByRole('button', { name: 'Save Step' }))

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith(
        'wait_for_custom_signal',
        expect.objectContaining({
          signalConfig: expect.objectContaining({ signalName: 'custom.quote.approved' }),
        }),
      )
    })
  })
})
