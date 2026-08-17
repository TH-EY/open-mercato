/**
 * @jest-environment jsdom
 */
import * as React from 'react'
import { render } from '@testing-library/react'
import { PortalMetricWidget } from '../widget.client'

const mockLineChart = jest.fn((_props: unknown) => null)

jest.mock('@open-mercato/shared/lib/i18n/context', () => ({
  useT: () => (_key: string, fallback: string) => fallback,
}))

jest.mock('@open-mercato/ui/backend/charts', () => ({
  LineChart: (props: unknown) => mockLineChart(props),
}))

jest.mock('@open-mercato/ui/backend/utils/apiCall', () => ({
  readApiResultOrThrow: jest.fn(() => new Promise(() => undefined)),
}))

describe('PortalMetricWidget', () => {
  beforeEach(() => {
    mockLineChart.mockClear()
  })

  it('labels only whole-number ticks on count charts', () => {
    render(<PortalMetricWidget metric="clicks" />)

    const chartProps = mockLineChart.mock.calls[0]?.[0] as { valueFormatter?: (value: number) => string } | undefined
    const valueFormatter = chartProps?.valueFormatter

    expect(valueFormatter).toBeDefined()
    expect([1, 0.75, 0.5, 0.25, 0].map((value) => valueFormatter?.(value))).toEqual([
      '1',
      '',
      '',
      '',
      '0',
    ])
  })
})
