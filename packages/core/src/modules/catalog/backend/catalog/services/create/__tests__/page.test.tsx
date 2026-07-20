/**
 * @jest-environment jsdom
 */
import * as React from 'react'
import { act, render } from '@testing-library/react'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { createCrud } from '@open-mercato/ui/backend/utils/crud'
import CreateCatalogServicePage from '../page'
import type { ServiceFormValues } from '../../../../../components/services/ServiceForm'

const mockTranslate = (_key: string, fallback?: string) => fallback ?? _key
let capturedSubmit: ((values: ServiceFormValues) => Promise<void>) | null = null

jest.mock('@open-mercato/shared/lib/i18n/context', () => ({
  useT: () => mockTranslate,
}))

jest.mock('@open-mercato/ui/backend/Page', () => ({
  Page: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PageBody: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

jest.mock('@open-mercato/ui/backend/utils/apiCall', () => ({ apiCall: jest.fn() }))
jest.mock('@open-mercato/ui/backend/utils/crud', () => ({ createCrud: jest.fn() }))

jest.mock('../../../../../components/services/ServiceForm', () => {
  const actual = jest.requireActual('../../../../../components/services/ServiceForm')
  return {
    ...actual,
    ServiceForm: (props: { onSubmit: (values: ServiceFormValues) => Promise<void> }) => {
      capturedSubmit = props.onSubmit
      return <div data-testid="service-form" />
    },
  }
})

describe('CreateCatalogServicePage', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    capturedSubmit = null
  })

  it('transfers uploaded media from the draft record to the created service', async () => {
    ;(createCrud as jest.Mock).mockResolvedValue({
      ok: true,
      result: { id: '11111111-1111-4111-8111-111111111111' },
    })
    ;(apiCall as jest.Mock).mockResolvedValue({ ok: true, result: { ok: true } })

    render(<CreateCatalogServicePage />)
    expect(capturedSubmit).toEqual(expect.any(Function))

    await act(async () => {
      await capturedSubmit!({
        title: 'Implementation workshop',
        description: '',
        scope: '',
        categoryId: '',
        defaultPriceAmount: '',
        defaultPriceCurrencyCode: '',
        defaultMediaId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        defaultMediaUrl: '',
        mediaDraftId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        mediaItems: [{
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          fileName: 'service-scope.pdf',
          url: '/api/attachments/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        }],
        workRequirements: [],
        isActive: true,
      })
    })

    expect(apiCall).toHaveBeenCalledWith(
      '/api/attachments/transfer',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          entityId: 'catalog:catalog_service',
          attachmentIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
          fromRecordId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          toRecordId: '11111111-1111-4111-8111-111111111111',
        }),
      }),
      { fallback: null },
    )
  })
})
