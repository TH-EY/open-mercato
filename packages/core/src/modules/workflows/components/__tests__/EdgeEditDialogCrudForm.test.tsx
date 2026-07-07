/** @jest-environment jsdom */
import * as React from 'react'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { renderWithProviders } from '@open-mercato/shared/lib/testing/renderWithProviders'
import { EdgeEditDialogCrudForm } from '../EdgeEditDialogCrudForm'

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

describe('EdgeEditDialogCrudForm', () => {
  it('submits newly added and renamed activities', async () => {
    const onSave = jest.fn()
    const edge = {
      id: 'start_to_end',
      source: 'start',
      target: 'end',
      data: {
        transitionName: 'Start to End',
        trigger: 'auto',
        priority: 100,
        activities: [
          {
            activityId: 'initial_lookup',
            activityName: 'Initial lookup',
            activityType: 'CALL_API',
            config: { endpoint: '/api/customers/deals?id={{context.id}}', method: 'GET' },
            retryPolicy: {
              maxAttempts: 3,
              initialIntervalMs: 1000,
              backoffCoefficient: 2,
              maxIntervalMs: 10000,
            },
          },
        ],
      },
    }

    renderWithProviders(
      <EdgeEditDialogCrudForm
        edge={edge as any}
        isOpen
        onClose={jest.fn()}
        onSave={onSave}
        onDelete={jest.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'workflows.fieldEditors.activities.addActivity' }))

    const generatedIdInput = screen.getByDisplayValue(/^activity_\d+$/)
    const generatedNameInput = screen.getByDisplayValue('workflows.common.newActivity')

    fireEvent.change(generatedIdInput, { target: { value: 'visual_lookup_added' } })
    fireEvent.change(generatedNameInput, { target: { value: 'Visual lookup added' } })

    fireEvent.click(screen.getByRole('button', { name: 'Save Transition' }))

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith(
        'start_to_end',
        expect.objectContaining({
          activities: expect.arrayContaining([
            expect.objectContaining({
              activityId: 'initial_lookup',
              activityName: 'Initial lookup',
            }),
            expect.objectContaining({
              activityId: 'visual_lookup_added',
              activityName: 'Visual lookup added',
              retryPolicy: {
                maxAttempts: 3,
                initialIntervalMs: 1000,
                backoffCoefficient: 2,
                maxIntervalMs: 10000,
              },
            }),
          ]),
        }),
      )
    })
  })
})
