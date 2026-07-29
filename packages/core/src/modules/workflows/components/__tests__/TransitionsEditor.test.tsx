/** @jest-environment jsdom */
import * as React from 'react'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { renderWithProviders } from '@open-mercato/shared/lib/testing/renderWithProviders'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { TransitionsEditor } from '../TransitionsEditor'

jest.mock('@open-mercato/ui/backend/utils/apiCall', () => ({
  apiCall: jest.fn(),
}))

const apiCallMock = apiCall as jest.Mock

beforeAll(() => {
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false
  if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = () => undefined
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => undefined
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    writable: true,
    value: class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  })
})

beforeEach(() => {
  apiCallMock.mockResolvedValue({
    ok: true,
    status: 200,
    result: {
      items: [{
        path: '/api/sales/orders/{id}',
        method: 'GET',
        summary: 'Get order',
        tag: 'Sales',
        params: [{ name: 'id', in: 'path', required: true, type: 'string' }],
        hasRequestSchema: false,
      }],
    },
    response: {},
    cacheStatus: null,
  })
})

describe('TransitionsEditor', () => {
  it('offers endpoint discovery while retaining manual config fields', async () => {
    const onChange = jest.fn()

    renderWithProviders(
      <TransitionsEditor
        value={[{
          transitionId: 'start-to-end',
          transitionName: 'Start to end',
          fromStepId: 'start',
          toStepId: 'end',
          trigger: 'auto',
          activities: [{
            activityId: 'load-order',
            activityName: 'Load order',
            activityType: 'CALL_API',
            config: { custom: 'keep' },
          }],
        }]}
        onChange={onChange}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /workflows.endpointPicker.browse/ }))
    await waitFor(() => expect(screen.getByText('Get order')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Get order'))

    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({
        activities: [
          expect.objectContaining({
            config: {
              custom: 'keep',
              endpoint: '/api/sales/orders/{__om_required_id}',
              method: 'GET',
              headers: {},
            },
          }),
        ],
      }),
    ])
    expect(screen.getByLabelText('workflows.activities.config (JSON)')).toBeInTheDocument()
  })
})
