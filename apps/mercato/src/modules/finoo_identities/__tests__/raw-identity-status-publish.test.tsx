/**
 * @jest-environment jsdom
 */
import * as React from 'react'
import '@testing-library/jest-dom'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { apiCallOrThrow, readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import CompletenessDetailWidget from '../widgets/injection/completeness-detail/widget.client'
import RawIdentityWidget from '../widgets/injection/raw-identity/widget.client'

jest.mock('@open-mercato/shared/lib/i18n/context', () => {
  const translate = jest.fn((key: string) => key)
  return { useT: () => translate }
})
jest.mock('@open-mercato/shared/security/features', () => ({
  hasFeature: () => true,
}))
jest.mock('@open-mercato/ui/backend/BackendChromeProvider', () => ({
  useBackendChrome: () => ({ payload: { grantedFeatures: ['finoo_identities.manage'] } }),
}))
jest.mock('@open-mercato/ui/backend/FlashMessages', () => ({
  flash: jest.fn(),
}))
jest.mock('@open-mercato/ui/backend/injection/useGuardedMutation', () => ({
  useGuardedMutation: () => ({
    runMutation: jest.fn(async ({ operation }: { operation: () => Promise<unknown> }) => operation()),
    retryLastMutation: jest.fn(),
  }),
}))
jest.mock('@open-mercato/ui/backend/detail', () => ({
  ErrorMessage: ({ label }: { label: string }) => <div>{label}</div>,
  LoadingMessage: ({ label }: { label: string }) => <div>{label}</div>,
}))
jest.mock('@open-mercato/ui/backend/CrudForm', () => ({
  CrudForm: ({ onSubmit }: { onSubmit: (values: Record<string, unknown>) => Promise<void> }) => (
    <button
      type="button"
      onClick={() => void onSubmit({
        pesel: '00210112344',
        documentType: 'identity_card',
        issuingCountryCode: 'PL',
        documentNumber: 'QA108BEBEA2',
        issuedOn: '2026-01-01',
        expiresOn: '2036-01-01',
      })}
    >
      save-identity
    </button>
  ),
}))
jest.mock('@open-mercato/ui/backend/utils/apiCall', () => ({
  apiCallOrThrow: jest.fn(),
  readApiResultOrThrow: jest.fn(),
}))

const mockedApiCallOrThrow = jest.mocked(apiCallOrThrow)
const mockedReadApiResultOrThrow = jest.mocked(readApiResultOrThrow)

const missingStatuses = {
  pesel: 'missing',
  documentType: 'missing',
  issuingCountryCode: 'missing',
  documentNumber: 'missing',
  issuedOn: 'missing',
  expiresOn: 'missing',
} as const

const completeStatuses = {
  pesel: 'complete',
  documentType: 'complete',
  issuingCountryCode: 'complete',
  documentNumber: 'complete',
  issuedOn: 'complete',
  expiresOn: 'complete',
} as const

function createSharedState() {
  const values = new Map<string, unknown>()
  const subscribers = new Map<string, Set<(value: unknown) => void>>()
  return {
    get<T>(key: string): T | undefined {
      return values.get(key) as T | undefined
    },
    set<T>(key: string, value: T): void {
      values.set(key, value)
      for (const subscriber of subscribers.get(key) ?? []) subscriber(value)
    },
    subscribe(key: string, subscriber: (value: unknown) => void): () => void {
      const current = subscribers.get(key) ?? new Set<(value: unknown) => void>()
      current.add(subscriber)
      subscribers.set(key, current)
      return () => current.delete(subscriber)
    },
  }
}

describe('raw identity status publication', () => {
  it('updates the sibling completeness widget through the real successful save callback', async () => {
    let resolveStatusRequest: ((value: { statuses: typeof missingStatuses }) => void) | undefined
    const statusRequest = new Promise<{ statuses: typeof missingStatuses }>((resolve) => {
      resolveStatusRequest = resolve
    })
    mockedReadApiResultOrThrow.mockImplementation(async (url) => {
      const path = String(url)
      if (path.includes('/import-conflicts')) return { items: [] }
      if (path.endsWith('/status')) return statusRequest
      return {
        id: 'identity-1',
        pesel: '',
        documentType: null,
        issuingCountryCode: null,
        documentNumber: null,
        issuedOn: null,
        expiresOn: null,
        isComplete: false,
        statuses: missingStatuses,
        updatedAt: '2026-08-26T10:00:00.000Z',
      }
    })
    mockedApiCallOrThrow.mockResolvedValue({
      response: { ok: true, status: 200 } as Response,
      result: {
        id: 'identity-1',
        isComplete: true,
        statuses: completeStatuses,
        updatedAt: '2026-08-26T10:01:00.000Z',
      },
    })
    const context = { personId: 'person-1', sharedState: createSharedState() }

    render(
      <>
        <CompletenessDetailWidget
          context={context}
          data={{ person: { id: 'person-1', _finooIdentities: { statuses: missingStatuses } } }}
        />
        <RawIdentityWidget context={context} data={{ person: { id: 'person-1' } }} />
      </>,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'save-identity' }))

    await waitFor(() => expect(screen.getAllByText('finoo_identities.status.complete')).toHaveLength(6))
    expect(mockedApiCallOrThrow).toHaveBeenCalledWith(
      '/api/finoo_identities/people/person-1',
      expect.objectContaining({ method: 'PUT' }),
      { errorMessage: 'finoo_identities.errors.save' },
    )

    await act(async () => {
      resolveStatusRequest?.({ statuses: missingStatuses })
      await statusRequest
    })
    expect(screen.getAllByText('finoo_identities.status.complete')).toHaveLength(6)
  })
})
