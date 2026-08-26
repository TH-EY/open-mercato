/**
 * @jest-environment jsdom
 */
import * as React from 'react'
import '@testing-library/jest-dom'
import { act, render, screen, waitFor } from '@testing-library/react'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import CompletenessDetailWidget from '../widgets/injection/completeness-detail/widget.client'
import { publishIdentityStatuses } from '../widgets/injection/identity-status-sync'

jest.mock('@open-mercato/shared/lib/i18n/context', () => {
  const translate = jest.fn((key: string) => key)
  return { useT: () => translate }
})
jest.mock('@open-mercato/ui/backend/utils/apiCall', () => ({
  readApiResultOrThrow: jest.fn(),
}))

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

describe('CompletenessDetailWidget', () => {
  beforeEach(() => {
    mockedReadApiResultOrThrow.mockResolvedValue({ statuses: missingStatuses })
  })

  it('updates every neutral status immediately after a sibling identity write', () => {
    const values = new Map<string, unknown>()
    const subscribers = new Map<string, Set<(value: unknown) => void>>()
    const sharedState = {
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
    const context = { personId: 'person-1', sharedState }

    render(<CompletenessDetailWidget
      context={context}
      data={{ person: { id: 'person-1', _finooIdentities: { statuses: missingStatuses } } }}
    />)
    expect(screen.getAllByText('finoo_identities.status.missing')).toHaveLength(6)

    act(() => publishIdentityStatuses(context, 'person-1', completeStatuses))

    expect(screen.getAllByText('finoo_identities.status.complete')).toHaveLength(6)
  })

  it('treats persisted shared state as an event channel and refreshes from the server on remount', async () => {
    const values = new Map<string, unknown>()
    const sharedState = {
      get<T>(key: string): T | undefined {
        return values.get(key) as T | undefined
      },
      set<T>(key: string, value: T): void {
        values.set(key, value)
      },
      subscribe: jest.fn(() => () => undefined),
    }
    const context = { personId: 'person-1', sharedState }
    publishIdentityStatuses(context, 'person-1', completeStatuses)

    render(<CompletenessDetailWidget
      context={context}
      data={{ person: { id: 'person-1', _finooIdentities: { statuses: missingStatuses } } }}
    />)

    expect(screen.queryByText('finoo_identities.status.complete')).not.toBeInTheDocument()
    await waitFor(() => expect(mockedReadApiResultOrThrow).toHaveBeenCalledWith(
      '/api/finoo_identities/people/person-1/status',
      { cache: 'no-store' },
      { errorMessage: 'finoo_identities.errors.loadStatus' },
    ))
    expect(screen.getAllByText('finoo_identities.status.missing')).toHaveLength(6)
  })
})
