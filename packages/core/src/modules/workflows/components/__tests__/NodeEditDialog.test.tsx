/** @jest-environment jsdom */
import * as React from 'react'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { renderWithProviders } from '@open-mercato/shared/lib/testing/renderWithProviders'
import { NodeEditDialog } from '../NodeEditDialog'

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

describe('NodeEditDialog', () => {
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

  it('selects a declared signal from the event catalog', async () => {
    const onSave = jest.fn()

    renderWithProviders(
      <NodeEditDialog
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

    fireEvent.focus(screen.getByPlaceholderText('workflows.form.placeholders.signalName'))
    fireEvent.click(await screen.findByText('Quote Status Changed'))
    fireEvent.click(screen.getByRole('button', { name: 'workflows.actions.saveChanges' }))

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
      <NodeEditDialog
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

    const input = screen.getByPlaceholderText('workflows.form.placeholders.signalName')
    fireEvent.change(input, { target: { value: 'custom.quote.approved' } })
    fireEvent.blur(input)
    fireEvent.click(screen.getByRole('button', { name: 'workflows.actions.saveChanges' }))

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith(
        'wait_for_custom_signal',
        expect.objectContaining({
          signalConfig: expect.objectContaining({ signalName: 'custom.quote.approved' }),
        }),
      )
    })
  })

  it('loads and saves correlated signal paths', async () => {
    const onSave = jest.fn()

    renderWithProviders(
      <NodeEditDialog
        node={{
          id: 'wait_for_customer_task',
          type: 'waitForSignal',
          data: {
            label: 'Wait for customer task',
            signalConfig: {
              signalName: 'customers.interaction.completed',
              timeout: 'P1D',
              correlation: {
                contextPath: 'activities.create_customer_task.body.id',
                payloadPath: 'id',
              },
            },
          },
        } as any}
        isOpen
        onClose={jest.fn()}
        onSave={onSave}
        onDelete={jest.fn()}
      />,
    )

    expect(screen.getByDisplayValue('activities.create_customer_task.body.id')).toBeInTheDocument()
    expect(screen.getByDisplayValue('id')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'workflows.actions.saveChanges' }))

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith(
        'wait_for_customer_task',
        expect.objectContaining({
          signalConfig: {
            signalName: 'customers.interaction.completed',
            timeout: 'P1D',
            correlation: {
              contextPath: 'activities.create_customer_task.body.id',
              payloadPath: 'id',
            },
          },
        }),
      )
    })
  })

  it('requires both correlated signal paths before saving', async () => {
    const onSave = jest.fn()

    renderWithProviders(
      <NodeEditDialog
        node={{
          id: 'wait_for_customer_task',
          type: 'waitForSignal',
          data: {
            label: 'Wait for customer task',
            signalConfig: {
              signalName: 'customers.interaction.completed',
            },
          },
        } as any}
        isOpen
        onClose={jest.fn()}
        onSave={onSave}
      />,
    )

    fireEvent.change(screen.getByPlaceholderText('workflows.form.placeholders.signalCorrelationContextPath'), {
      target: { value: 'activities.create_customer_task.body.id' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'workflows.actions.saveChanges' }))

    expect((await screen.findAllByText('workflows.validation.signalCorrelationPairRequired')).length).toBeGreaterThan(0)
    expect(onSave).not.toHaveBeenCalled()
  })

  it('submits user task form config without stale advanced config overwriting it', async () => {
    const onSave = jest.fn()

    renderWithProviders(
      <NodeEditDialog
        node={{
          id: 'usertask_initial_contact',
          type: 'userTask',
          data: {
            label: 'Initial contact',
            userTaskConfig: {},
          },
        } as any}
        isOpen
        onClose={jest.fn()}
        onSave={onSave}
        onDelete={jest.fn()}
      />,
    )

    fireEvent.change(screen.getByPlaceholderText('workflows.form.placeholders.roles'), {
      target: { value: 'Sales Representative' },
    })
    fireEvent.change(screen.getByPlaceholderText('workflows.form.placeholders.formKey'), {
      target: { value: 'initial_contact_form' },
    })

    fireEvent.click(screen.getByRole('button', { name: 'workflows.form.addField' }))

    fireEvent.change(screen.getByDisplayValue(/^field_\d+$/), {
      target: { value: 'conversation_summary' },
    })
    fireEvent.change(screen.getByDisplayValue('workflows.form.newField'), {
      target: { value: 'Conversation summary' },
    })
    fireEvent.change(screen.getByPlaceholderText('workflows.form.placeholders.placeholder'), {
      target: { value: 'Please fill in the details of the conversation' },
    })

    fireEvent.click(screen.getByRole('button', { name: 'workflows.actions.saveChanges' }))

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith(
        'usertask_initial_contact',
        expect.objectContaining({
          assignedToRoles: ['Sales Representative'],
          formKey: 'initial_contact_form',
          userTaskConfig: expect.objectContaining({
            assignedToRoles: ['Sales Representative'],
            formSchema: {
              fields: [
                expect.objectContaining({
                  name: 'conversation_summary',
                  type: 'text',
                  label: 'Conversation summary',
                  required: false,
                  placeholder: 'Please fill in the details of the conversation',
                }),
              ],
            },
          }),
        }),
      )
    })
  })
})
