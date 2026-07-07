/** @jest-environment jsdom */
import * as React from 'react'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { renderWithProviders } from '@open-mercato/shared/lib/testing/renderWithProviders'
import { EdgeEditDialog } from '../EdgeEditDialog'

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

describe('EdgeEditDialog', () => {
  it('submits edited activities without stale advanced config overwriting them', async () => {
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
            config: { endpoint: '/api/customers/deals', method: 'GET' },
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
      <EdgeEditDialog
        edge={edge as any}
        isOpen
        onClose={jest.fn()}
        onSave={onSave}
        onDelete={jest.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Initial lookup/ }))
    fireEvent.change(screen.getByDisplayValue('Initial lookup'), {
      target: { value: 'Initial lookup renamed' },
    })

    fireEvent.click(screen.getByRole('button', { name: 'workflows.edgeEditor.addActivity' }))

    const generatedIdInput = screen.getByDisplayValue(/^activity_\d+$/)
    const generatedNameInput = screen.getByDisplayValue('workflows.common.newActivity')

    fireEvent.change(generatedIdInput, { target: { value: 'visual_lookup_added' } })
    fireEvent.change(generatedNameInput, { target: { value: 'Visual lookup added' } })

    fireEvent.click(screen.getByRole('button', { name: 'workflows.edgeEditor.saveChanges' }))

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith(
        'start_to_end',
        expect.objectContaining({
          activities: [
            expect.objectContaining({
              activityId: 'initial_lookup',
              activityName: 'Initial lookup renamed',
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
          ],
        }),
      )
    })
  })
})
