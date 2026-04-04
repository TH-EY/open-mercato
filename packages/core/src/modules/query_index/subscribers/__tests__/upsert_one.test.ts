const mockUpsertIndexRow = jest.fn()
const mockApplyCoverageAdjustments = jest.fn()
const mockCreateCoverageAdjustments = jest.fn(() => [])
const mockRecordIndexerError = jest.fn()

jest.mock('../../lib/indexer', () => ({
  upsertIndexRow: (...args: unknown[]) => mockUpsertIndexRow(...args),
}))

jest.mock('../../lib/coverage', () => ({
  applyCoverageAdjustments: (...args: unknown[]) => mockApplyCoverageAdjustments(...args),
  createCoverageAdjustments: (...args: unknown[]) => mockCreateCoverageAdjustments(...args),
}))

jest.mock('@open-mercato/shared/lib/indexers/error-log', () => ({
  recordIndexerError: (...args: unknown[]) => mockRecordIndexerError(...args),
}))

import handle from '../upsert_one'

describe('query_index upsert_one subscriber', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockUpsertIndexRow.mockResolvedValue({
      doc: { deleted_at: null },
      created: true,
      revived: false,
    })
  })

  it('skips vector and fulltext fan-out when deferred search reindex is requested', async () => {
    const emitEvent = jest.fn(async () => undefined)

    await handle(
      {
        entityType: 'customers:customer_person_profile',
        recordId: 'record-1',
        tenantId: 'tenant-1',
        organizationId: 'org-1',
        suppressCoverage: true,
        suppressVectorize: true,
        suppressSearchIndexing: true,
      },
      {
        resolve: <T = unknown>(name: string): T => {
          if (name === 'em') return {} as T
          if (name === 'eventBus') {
            return { emitEvent } as T
          }
          throw new Error(`Unexpected resolve: ${name}`)
        },
      },
    )

    expect(mockUpsertIndexRow).toHaveBeenCalledWith({}, {
      entityType: 'customers:customer_person_profile',
      recordId: 'record-1',
      tenantId: 'tenant-1',
      organizationId: 'org-1',
    })
    expect(emitEvent).not.toHaveBeenCalledWith('query_index.vectorize_one', expect.anything())
    expect(emitEvent).not.toHaveBeenCalledWith('search.index_record', expect.anything())
  })
})
