/**
 * @jest-environment jsdom
 */
import * as React from 'react'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { renderWithProviders } from '@open-mercato/shared/lib/testing/renderWithProviders'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { EndpointPicker, type EndpointPickerItem } from '../fields/EndpointPicker'

jest.mock('@open-mercato/ui/backend/utils/apiCall', () => ({
  apiCall: jest.fn(),
}))

const apiCallMock = apiCall as jest.Mock

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    writable: true,
    value: ResizeObserverMock,
  })
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false
  if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = () => undefined
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => undefined
})

const catalog: EndpointPickerItem[] = [{
  path: '/api/sales/orders/{id}',
  method: 'GET',
  summary: 'Get order',
  tag: 'Sales',
  params: [
    { name: 'include', in: 'query', required: false, type: 'string' },
    { name: 'page', in: 'query', required: true, type: 'integer' },
    { name: 'id', in: 'path', required: true, type: 'string' },
    { name: 'x-region', in: 'header', required: true, type: 'string' },
  ],
  hasRequestSchema: true,
  requestSchema: {
    type: 'object',
    properties: { body: { type: 'object' } },
    required: ['body'],
  },
  responseSchema: {
    type: 'object',
    properties: { data: { type: 'object' }, meta: { type: 'object' } },
    required: ['data'],
  },
}]

function mockCatalog(items: EndpointPickerItem[], ok = true) {
  apiCallMock.mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    result: ok ? { items } : {},
    response: {},
    cacheStatus: null,
  })
}

function Harness({ onApplySpy }: {
  onApplySpy?: jest.Mock
}) {
  const [config, setConfig] = React.useState<{
    endpoint: string
    method: string
    headers: Record<string, unknown>
  }>({ endpoint: '', method: 'GET', headers: {} })

  return (
    <EndpointPicker
      id="call-api-endpoint"
      endpoint={config.endpoint}
      method={config.method}
      headers={config.headers}
      onApply={(patch) => {
        onApplySpy?.(patch)
        setConfig((current) => ({ ...current, ...patch }))
      }}
    />
  )
}

beforeEach(() => {
  apiCallMock.mockReset()
  mockCatalog(catalog)
})

describe('EndpointPicker', () => {
  it('keeps manual endpoint editing available', async () => {
    const onApplySpy = jest.fn()
    renderWithProviders(<Harness onApplySpy={onApplySpy} />)

    fireEvent.change(screen.getByPlaceholderText('workflows.endpointPicker.placeholder'), {
      target: { value: '/api/custom/action' },
    })

    expect(onApplySpy).toHaveBeenCalledWith({ endpoint: '/api/custom/action' })
    await waitFor(() => expect(apiCallMock).toHaveBeenCalled())
  })

  it('searches the catalog and initializes required parameter placeholders', async () => {
    const onApplySpy = jest.fn()
    renderWithProviders(<Harness onApplySpy={onApplySpy} />)

    fireEvent.click(screen.getByRole('button', { name: /workflows.endpointPicker.browse/ }))
    await waitFor(() => expect(screen.getByText('Sales')).toBeInTheDocument())
    expect(screen.getByText('Get order')).toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText('workflows.endpointPicker.searchPlaceholder'), {
      target: { value: 'orders' },
    })
    fireEvent.click(screen.getByText('Get order'))

    expect(onApplySpy).toHaveBeenCalledWith({
      endpoint: '/api/sales/orders/{__om_required_id}?page={__om_required_page}',
      method: 'GET',
      headers: { 'x-region': '{__om_required_x-region}' },
    })
  })

  it('validates required path, query, and header params and renders both schemas', async () => {
    renderWithProviders(<Harness />)

    fireEvent.click(screen.getByRole('button', { name: /workflows.endpointPicker.browse/ }))
    await waitFor(() => expect(screen.getByText('Get order')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Get order'))

    await waitFor(() => {
      expect(screen.getByLabelText('id *')).toHaveAttribute('aria-invalid', 'true')
    })
    expect(screen.getByLabelText('page *')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByLabelText('x-region *')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText('body*: object')).toBeInTheDocument()
    expect(screen.getByText('data*: object')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('id *'), { target: { value: '{{context.orderId}}' } })
    fireEvent.change(screen.getByLabelText('page *'), { target: { value: '1' } })
    fireEvent.change(screen.getByLabelText('x-region *'), { target: { value: 'eu' } })

    await waitFor(() => {
      expect(screen.getByLabelText('id *')).toHaveAttribute('aria-invalid', 'false')
      expect(screen.getByLabelText('page *')).toHaveAttribute('aria-invalid', 'false')
      expect(screen.getByLabelText('x-region *')).toHaveAttribute('aria-invalid', 'false')
    })
  })

  it('omits optional path params and removes stale generated headers when switching operations', async () => {
    const onApplySpy = jest.fn()
    mockCatalog([
      ...catalog,
      {
        path: '/api/attachments/image/{id}/{slug}',
        method: 'GET',
        summary: 'Get attachment image',
        tag: 'Attachments',
        params: [
          { name: 'id', in: 'path', required: true, type: 'string' },
          { name: 'slug', in: 'path', required: false, type: 'string' },
        ],
        hasRequestSchema: false,
      },
    ])
    renderWithProviders(<Harness onApplySpy={onApplySpy} />)

    fireEvent.click(screen.getByRole('button', { name: /workflows.endpointPicker.browse/ }))
    await waitFor(() => expect(screen.getByText('Get order')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Get order'))

    fireEvent.click(screen.getByRole('button', { name: /workflows.endpointPicker.browse/ }))
    await waitFor(() => expect(screen.getByText('Get attachment image')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Get attachment image'))

    expect(onApplySpy).toHaveBeenLastCalledWith({
      endpoint: '/api/attachments/image/{__om_required_id}',
      method: 'GET',
      headers: {},
    })
  })

  it('encodes literal parameter values while preserving workflow interpolation tokens', async () => {
    const onApplySpy = jest.fn()
    renderWithProviders(<Harness onApplySpy={onApplySpy} />)

    fireEvent.click(screen.getByRole('button', { name: /workflows.endpointPicker.browse/ }))
    await waitFor(() => expect(screen.getByText('Get order')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Get order'))

    fireEvent.change(screen.getByLabelText('id *'), { target: { value: 'A/B' } })
    expect(onApplySpy).toHaveBeenLastCalledWith(expect.objectContaining({
      endpoint: expect.stringContaining('/api/sales/orders/A%2FB'),
    }))
    fireEvent.change(screen.getByLabelText('page *'), { target: { value: 'A&B' } })
    expect(onApplySpy).toHaveBeenLastCalledWith(expect.objectContaining({
      endpoint: expect.stringContaining('page=A%26B'),
    }))
    fireEvent.change(screen.getByLabelText('id *'), { target: { value: '{{context.orderId}}' } })
    expect(onApplySpy).toHaveBeenLastCalledWith(expect.objectContaining({
      endpoint: expect.stringContaining('/api/sales/orders/{{context.orderId}}'),
    }))
  })

  it('degrades to the manual input when catalog lookup fails', async () => {
    mockCatalog([], false)
    renderWithProviders(<Harness />)

    fireEvent.click(screen.getByRole('button', { name: /workflows.endpointPicker.browse/ }))
    await waitFor(() => {
      expect(screen.getAllByText('workflows.endpointPicker.lookupUnavailable')).not.toHaveLength(0)
    })
    expect(screen.getByPlaceholderText('workflows.endpointPicker.placeholder')).toBeEnabled()
  })
})
