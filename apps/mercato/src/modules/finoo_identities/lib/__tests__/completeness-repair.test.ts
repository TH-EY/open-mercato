import { FinooIdentityAuditEntry, FinooPersonIdentity } from '../../data/entities'
import { repairIdentityCompleteness } from '../completeness-repair'

const findWithDecryption = jest.fn()

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findWithDecryption: (...args: unknown[]) => findWithDecryption(...args),
}))

const scope = {
  tenantId: '5164d495-1865-4738-b459-2783999a761d',
  organizationId: 'd0d98cb3-28cf-4376-a61c-d270020f166f',
}

const encryptionService = {
  isEnabled: jest.fn(() => true),
  getDek: jest.fn(async () => ({ key: 'test-key' })),
  getEncryptedFieldNames: jest.fn(async () => [
    'pesel',
    'document_type',
    'issuing_country_code',
    'document_number',
    'issued_on',
    'expires_on',
  ]),
}

function identity(overrides: Partial<FinooPersonIdentity> = {}): FinooPersonIdentity {
  return Object.assign(new FinooPersonIdentity(), {
    id: 'ee823a18-e50c-4de4-9d71-4f516d7d754e',
    ...scope,
    personId: 'f15fc8f6-a97e-4f13-8970-069e14e7f237',
    pesel: '44051401458',
    documentType: 'identity_card',
    issuingCountryCode: null,
    documentNumber: 'ABC123456',
    issuedOn: '2024-01-10',
    expiresOn: '2034-01-10',
    isComplete: false,
    fieldStatuses: {
      pesel: 'complete',
      documentType: 'complete',
      issuingCountryCode: 'missing',
      documentNumber: 'complete',
      issuedOn: 'complete',
      expiresOn: 'complete',
    },
    ...overrides,
  })
}

function entityManager() {
  const flush = jest.fn(async () => undefined)
  const persist = jest.fn()
  const create = jest.fn((entity: unknown, data: Record<string, unknown>) => ({ entity, ...data }))
  const em = { create, flush, persist } as Record<string, unknown>
  em.transactional = async (callback: (transactionalEm: unknown) => Promise<unknown>) => callback(em)
  return { em, create, flush, persist }
}

describe('FINOO identity completeness repair', () => {
  beforeEach(() => findWithDecryption.mockReset())

  it('returns count-only changes without mutating rows in dry-run mode', async () => {
    const row = identity()
    findWithDecryption.mockResolvedValueOnce([row]).mockResolvedValueOnce([])
    const fixture = entityManager()

    const report = await repairIdentityCompleteness({
      em: fixture.em as never,
      encryptionService: encryptionService as never,
      scope,
      mode: 'dry-run',
      batchSize: 10,
    })

    expect(report).toEqual({
      mode: 'dry-run',
      scanned: 1,
      countryConflicts: 0,
      countriesNormalized: 0,
      completenessUpdated: 0,
      wouldNormalizeCountries: 1,
      wouldUpdateCompleteness: 1,
    })
    expect(row.issuingCountryCode).toBeNull()
    expect(row.isComplete).toBe(false)
    expect(fixture.persist).not.toHaveBeenCalled()
    expect(fixture.flush).not.toHaveBeenCalled()
    expect(JSON.stringify(report)).not.toContain(row.id)
    expect(JSON.stringify(report)).not.toContain(row.pesel)
  })

  it('normalizes domestic country and stored statuses idempotently in the exact scope', async () => {
    const row = identity()
    findWithDecryption
      .mockResolvedValueOnce([row])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([row])
      .mockResolvedValueOnce([])
    const fixture = entityManager()

    const first = await repairIdentityCompleteness({
      em: fixture.em as never,
      encryptionService: encryptionService as never,
      scope,
      mode: 'apply',
      batchSize: 10,
    })
    const second = await repairIdentityCompleteness({
      em: fixture.em as never,
      encryptionService: encryptionService as never,
      scope,
      mode: 'apply',
      batchSize: 10,
    })

    expect(first).toMatchObject({ countriesNormalized: 1, completenessUpdated: 1 })
    expect(second).toMatchObject({ countriesNormalized: 0, completenessUpdated: 0 })
    expect(row.issuingCountryCode).toBe('PL')
    expect(row.isComplete).toBe(true)
    expect(fixture.create).toHaveBeenCalledWith(FinooIdentityAuditEntry, expect.objectContaining({
      actorUserId: null,
      actorKind: 'system',
      personId: row.personId,
      operation: 'update',
      outcome: 'allowed',
      changedFields: ['issuingCountryCode'],
    }))
    expect(JSON.stringify(fixture.create.mock.calls)).not.toContain(row.pesel)
    expect(findWithDecryption).toHaveBeenCalledWith(
      expect.anything(),
      FinooPersonIdentity,
      expect.objectContaining({ ...scope, deletedAt: null }),
      expect.objectContaining({ orderBy: { id: 'ASC' }, limit: 10 }),
      scope,
    )
  })

  it('treats jsonb-reordered status keys as semantically unchanged', async () => {
    const row = identity({
      issuingCountryCode: 'PL',
      isComplete: true,
      fieldStatuses: {
        pesel: 'complete',
        issuedOn: 'complete',
        expiresOn: 'complete',
        documentType: 'complete',
        documentNumber: 'complete',
        issuingCountryCode: 'complete',
      },
    })
    findWithDecryption.mockResolvedValueOnce([row]).mockResolvedValueOnce([])
    const fixture = entityManager()

    const report = await repairIdentityCompleteness({
      em: fixture.em as never,
      encryptionService: encryptionService as never,
      scope,
      mode: 'dry-run',
      batchSize: 10,
    })

    expect(report).toMatchObject({
      scanned: 1,
      wouldNormalizeCountries: 0,
      wouldUpdateCompleteness: 0,
    })
    expect(fixture.persist).not.toHaveBeenCalled()
  })

  it('reports but does not overwrite a conflicting foreign country on a Polish document', async () => {
    const row = identity({ issuingCountryCode: 'DE' })
    findWithDecryption.mockResolvedValueOnce([row]).mockResolvedValueOnce([])
    const fixture = entityManager()

    const report = await repairIdentityCompleteness({
      em: fixture.em as never,
      encryptionService: encryptionService as never,
      scope,
      mode: 'apply',
    })

    expect(report.countryConflicts).toBe(1)
    expect(report.countriesNormalized).toBe(0)
    expect(row.issuingCountryCode).toBe('DE')
    expect(row.isComplete).toBe(false)
  })

  it('fails closed before reading identities when encryption maps are incomplete', async () => {
    const fixture = entityManager()
    const incompleteEncryption = {
      ...encryptionService,
      getEncryptedFieldNames: jest.fn(async () => ['pesel']),
    }

    await expect(repairIdentityCompleteness({
      em: fixture.em as never,
      encryptionService: incompleteEncryption as never,
      scope,
      mode: 'dry-run',
    })).rejects.toThrow('identity_encryption_unavailable')
    expect(findWithDecryption).not.toHaveBeenCalled()
  })
})
