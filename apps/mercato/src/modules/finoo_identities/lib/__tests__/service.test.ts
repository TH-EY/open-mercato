import { isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { CustomerEntity } from '@open-mercato/core/modules/customers/data/entities'
import { FinooIdentityAuditEntry, FinooIdentityImportConflict, FinooPersonIdentity } from '../../data/entities'
import { createFinooIdentityService } from '../service'

const findOneWithDecryption = jest.fn()
const findAndCountWithDecryption = jest.fn()
const encryptionService = {
  isEnabled: jest.fn(() => true),
  getDek: jest.fn(async () => ({ key: Buffer.alloc(32), keyVersion: 1, fetchedAt: Date.now() })),
  getEncryptedFieldNames: jest.fn(async (entityId: string) => entityId === 'finoo_identities:finoo_person_identity'
    ? ['pesel', 'document_type', 'issuing_country_code', 'document_number', 'issued_on', 'expires_on']
    : [
        'candidate_pesel',
        'candidate_document_type',
        'candidate_issuing_country_code',
        'candidate_document_number',
        'candidate_issued_on',
        'candidate_expires_on',
      ]),
}

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: (...args: unknown[]) => findOneWithDecryption(...args),
  findAndCountWithDecryption: (...args: unknown[]) => findAndCountWithDecryption(...args),
}))

describe('FinooIdentityService', () => {
  beforeEach(() => {
    findOneWithDecryption.mockReset()
    findAndCountWithDecryption.mockReset()
    encryptionService.isEnabled.mockReset().mockReturnValue(true)
    encryptionService.getDek.mockReset().mockResolvedValue({ key: Buffer.alloc(32), keyVersion: 1, fetchedAt: Date.now() })
    encryptionService.getEncryptedFieldNames.mockReset().mockImplementation(async (entityId: string) => (
      entityId === 'finoo_identities:finoo_person_identity'
        ? ['pesel', 'document_type', 'issuing_country_code', 'document_number', 'issued_on', 'expires_on']
        : [
            'candidate_pesel',
            'candidate_document_type',
            'candidate_issuing_country_code',
            'candidate_document_number',
            'candidate_issued_on',
            'candidate_expires_on',
          ]
    ))
  })

  it('denies an ordinary user before reading identity values and records a value-free audit', async () => {
    const persisted: unknown[] = []
    const em = {
      create: (_entity: unknown, data: Record<string, unknown>) => ({ id: 'audit-entry-id', ...data }),
      persist: (entity: unknown) => {
        persisted.push(entity)
      },
      flush: jest.fn(async () => undefined),
      findOne: jest.fn(async () => {
        throw new Error('identity data must not be queried after denied authorization')
      }),
    }
    const rbacService = {
      userHasAllFeatures: jest.fn(async () => false),
    }
    const service = createFinooIdentityService({
      em: em as never,
      rbacService: rbacService as never,
      encryptionService: encryptionService as never,
    })

    let caught: unknown
    try {
      await service.readForAuthorizedActor({
        actorUserId: '54af32b0-9209-48b2-a78d-13d2602ea741',
        tenantId: '5164d495-1865-4738-b459-2783999a761d',
        organizationId: 'd0d98cb3-28cf-4376-a61c-d270020f166f',
        personId: 'ee823a18-e50c-4de4-9d71-4f516d7d754e',
      })
    } catch (error) {
      caught = error
    }

    expect(isCrudHttpError(caught)).toBe(true)
    if (!isCrudHttpError(caught)) throw caught
    expect(caught.status).toBe(403)
    expect(caught.body).toEqual({ error: 'identity_access_denied' })
    expect(findOneWithDecryption).not.toHaveBeenCalled()
    expect(persisted).toHaveLength(1)
    expect(persisted[0]).toMatchObject({
      tenantId: '5164d495-1865-4738-b459-2783999a761d',
      organizationId: 'd0d98cb3-28cf-4376-a61c-d270020f166f',
      actorUserId: '54af32b0-9209-48b2-a78d-13d2602ea741',
      actorKind: 'user',
      personId: 'ee823a18-e50c-4de4-9d71-4f516d7d754e',
      operation: 'read',
      outcome: 'denied',
      changedFields: null,
    })
    expect(JSON.stringify(persisted[0])).not.toContain('44051401458')
  })

  it.each([
    ['disabled encryption', () => encryptionService.isEnabled.mockReturnValue(false)],
    ['missing tenant DEK', () => encryptionService.getDek.mockResolvedValue(null as never)],
    ['incomplete encryption map', () => encryptionService.getEncryptedFieldNames.mockResolvedValue(['pesel'])],
  ])('fails closed before a raw write when there is %s', async (_caseName, configureEncryption) => {
    configureEncryption()
    const persisted: unknown[] = []
    const em = {
      create: (_entity: unknown, data: Record<string, unknown>) => ({ id: 'unexpected-id', ...data }),
      persist: (entity: unknown) => persisted.push(entity),
      flush: jest.fn(async () => undefined),
    }
    const service = createFinooIdentityService({
      em: em as never,
      rbacService: { userHasAllFeatures: jest.fn(async () => true) } as never,
      encryptionService: encryptionService as never,
    })

    await expect(service.upsertForAuthorizedActor({
      scope: {
        actorUserId: '54af32b0-9209-48b2-a78d-13d2602ea741',
        tenantId: '5164d495-1865-4738-b459-2783999a761d',
        organizationId: 'd0d98cb3-28cf-4376-a61c-d270020f166f',
        personId: 'ee823a18-e50c-4de4-9d71-4f516d7d754e',
      },
      input: {
        pesel: '44051401458',
        documentType: 'identity_card',
        issuingCountryCode: 'PL',
        documentNumber: 'ABC123456',
        issuedOn: '2024-01-10',
        expiresOn: '2034-01-10',
      },
    })).rejects.toMatchObject({ status: 503, body: { error: 'identity_encryption_unavailable' } })
    expect(findOneWithDecryption).not.toHaveBeenCalled()
    expect(persisted).toHaveLength(0)
  })

  it('returns a scoped decrypted identity with statuses to an authorized actor and audits the read', async () => {
    const persisted: unknown[] = []
    const em = {
      create: (_entity: unknown, data: Record<string, unknown>) => ({ id: 'audit-entry-id', ...data }),
      persist: (entity: unknown) => {
        persisted.push(entity)
      },
      flush: jest.fn(async () => undefined),
    }
    const identity = {
      id: '4e5f6a45-e7fd-40df-85b5-ad8a6e82d5b5',
      tenantId: '5164d495-1865-4738-b459-2783999a761d',
      organizationId: 'd0d98cb3-28cf-4376-a61c-d270020f166f',
      personId: 'ee823a18-e50c-4de4-9d71-4f516d7d754e',
      pesel: '44051401458',
      documentType: 'identity_card',
      issuingCountryCode: 'PL',
      documentNumber: 'ABC123456',
      issuedOn: '2024-01-10',
      expiresOn: '2034-01-10',
      isComplete: true,
      updatedAt: new Date('2026-08-24T14:00:00.000Z'),
      deletedAt: null,
    }
    findOneWithDecryption.mockImplementation(async (_em: unknown, entity: unknown) => (
      entity === CustomerEntity ? { id: identity.personId, kind: 'person' } : identity
    ))
    const service = createFinooIdentityService({
      em: em as never,
      rbacService: { userHasAllFeatures: jest.fn(async () => true) } as never,
      encryptionService: encryptionService as never,
    })

    const result = await service.readForAuthorizedActor({
      actorUserId: '54af32b0-9209-48b2-a78d-13d2602ea741',
      tenantId: '5164d495-1865-4738-b459-2783999a761d',
      organizationId: 'd0d98cb3-28cf-4376-a61c-d270020f166f',
      personId: 'ee823a18-e50c-4de4-9d71-4f516d7d754e',
    })

    expect(result).toEqual({
      id: '4e5f6a45-e7fd-40df-85b5-ad8a6e82d5b5',
      pesel: '44051401458',
      documentType: 'identity_card',
      issuingCountryCode: 'PL',
      documentNumber: 'ABC123456',
      issuedOn: '2024-01-10',
      expiresOn: '2034-01-10',
      isComplete: true,
      statuses: {
        pesel: 'complete',
        documentType: 'complete',
        issuingCountryCode: 'complete',
        documentNumber: 'complete',
        issuedOn: 'complete',
        expiresOn: 'complete',
      },
      updatedAt: '2026-08-24T14:00:00.000Z',
    })
    expect(persisted).toHaveLength(1)
    expect(persisted[0]).toMatchObject({ operation: 'read', outcome: 'allowed' })
    expect(JSON.stringify(persisted[0])).not.toContain('44051401458')
  })

  it('returns only neutral statuses to an ordinary Person viewer', async () => {
    findOneWithDecryption.mockImplementation(async (_em: unknown, entity: unknown) => (
      entity === CustomerEntity
        ? { id: 'ee823a18-e50c-4de4-9d71-4f516d7d754e', kind: 'person' }
        : null
    ))
    const em = {
      findOne: jest.fn(async () => ({
        personId: 'ee823a18-e50c-4de4-9d71-4f516d7d754e',
        isComplete: false,
        fieldStatuses: {
          pesel: 'complete',
          documentType: 'complete',
          issuingCountryCode: 'missing',
          documentNumber: 'missing',
          issuedOn: 'complete',
          expiresOn: 'missing',
        },
      })),
    }
    const service = createFinooIdentityService({
      em: em as never,
      rbacService: { userHasAllFeatures: jest.fn(async (_userId, features) => features[0] === 'customers.people.view') } as never,
      encryptionService: encryptionService as never,
    })

    const result = await service.readStatusForPersonViewer({
      actorUserId: '54af32b0-9209-48b2-a78d-13d2602ea741',
      tenantId: '5164d495-1865-4738-b459-2783999a761d',
      organizationId: 'd0d98cb3-28cf-4376-a61c-d270020f166f',
      personId: 'ee823a18-e50c-4de4-9d71-4f516d7d754e',
    })

    expect(result).toEqual({
      isComplete: false,
      statuses: {
        pesel: 'complete',
        documentType: 'complete',
        issuingCountryCode: 'missing',
        documentNumber: 'missing',
        issuedOn: 'complete',
        expiresOn: 'missing',
      },
    })
    expect(JSON.stringify(result)).not.toContain('44051401458')
    expect(encryptionService.getDek).not.toHaveBeenCalled()
  })

  it('attributes a denied conflict resolution to the scoped Person without decrypting candidates', async () => {
    const persisted: unknown[] = []
    const execute = jest.fn(async () => [{ person_id: 'ee823a18-e50c-4de4-9d71-4f516d7d754e' }])
    const em = {
      create: (_entity: unknown, data: Record<string, unknown>) => ({ id: 'audit-entry-id', ...data }),
      persist: (entity: unknown) => persisted.push(entity),
      flush: jest.fn(async () => undefined),
      getConnection: () => ({ execute }),
    }
    const service = createFinooIdentityService({
      em: em as never,
      rbacService: { userHasAllFeatures: jest.fn(async () => false) } as never,
      encryptionService: encryptionService as never,
    })

    await expect(service.authorizeConflictManagementActor({
      scope: {
        actorUserId: '54af32b0-9209-48b2-a78d-13d2602ea741',
        tenantId: '5164d495-1865-4738-b459-2783999a761d',
        organizationId: 'd0d98cb3-28cf-4376-a61c-d270020f166f',
      },
      conflictId: '1dc885ce-a2ce-4053-a069-e27ae0942327',
      operation: 'resolve_conflict',
    })).rejects.toMatchObject({ status: 403, body: { error: 'identity_access_denied' } })

    expect(findOneWithDecryption).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('select person_id'), [
      '1dc885ce-a2ce-4053-a069-e27ae0942327',
      '5164d495-1865-4738-b459-2783999a761d',
      'd0d98cb3-28cf-4376-a61c-d270020f166f',
    ])
    expect(persisted[0]).toMatchObject({
      personId: 'ee823a18-e50c-4de4-9d71-4f516d7d754e',
      operation: 'resolve_conflict',
      outcome: 'denied',
    })
  })

  it('creates valid identity data for an authorized manager and returns only safe write metadata', async () => {
    const persisted: unknown[] = []
    const afterMutation = jest.fn(async () => undefined)
    const em: Record<string, unknown> = {}
    Object.assign(em, {
      create: (entity: unknown, data: Record<string, unknown>) => entity === FinooPersonIdentity
        ? {
            id: '4e5f6a45-e7fd-40df-85b5-ad8a6e82d5b5',
            ...data,
            createdAt: new Date('2026-08-24T14:00:00.000Z'),
            updatedAt: new Date('2026-08-24T14:00:00.000Z'),
            deletedAt: null,
          }
        : entity === FinooIdentityAuditEntry
          ? { id: 'audit-entry-id', ...data }
          : (() => { throw new Error('Unexpected entity') })(),
      persist: (entity: unknown) => {
        persisted.push(entity)
      },
      flush: jest.fn(async () => undefined),
      getConnection: () => ({ execute: jest.fn(async () => []) }),
      transactional: async (callback: (transactionalEm: unknown) => Promise<unknown>) => callback(em),
    })
    findOneWithDecryption.mockImplementation(async (_em: unknown, entity: unknown) => (
      entity === CustomerEntity
        ? { id: 'ee823a18-e50c-4de4-9d71-4f516d7d754e', kind: 'person' }
        : null
    ))
    const service = createFinooIdentityService({
      em: em as never,
      rbacService: { userHasAllFeatures: jest.fn(async () => true) } as never,
      encryptionService: encryptionService as never,
      afterMutation,
    })

    const result = await service.upsertForAuthorizedActor({
      scope: {
        actorUserId: '54af32b0-9209-48b2-a78d-13d2602ea741',
        tenantId: '5164d495-1865-4738-b459-2783999a761d',
        organizationId: 'd0d98cb3-28cf-4376-a61c-d270020f166f',
        personId: 'ee823a18-e50c-4de4-9d71-4f516d7d754e',
      },
      input: {
        pesel: '44051401458',
        documentType: 'identity_card',
        issuingCountryCode: 'PL',
        documentNumber: 'ABC123456',
        issuedOn: '2024-01-10',
        expiresOn: '2034-01-10',
      },
    })

    expect(result).toEqual({
      id: '4e5f6a45-e7fd-40df-85b5-ad8a6e82d5b5',
      isComplete: true,
      statuses: {
        pesel: 'complete',
        documentType: 'complete',
        issuingCountryCode: 'complete',
        documentNumber: 'complete',
        issuedOn: 'complete',
        expiresOn: 'complete',
      },
      updatedAt: '2026-08-24T14:00:00.000Z',
    })
    expect(persisted).toHaveLength(2)
    expect(persisted[0]).toMatchObject({ pesel: '44051401458', isComplete: true })
    expect(persisted[1]).toMatchObject({
      operation: 'create',
      outcome: 'allowed',
      changedFields: ['pesel', 'documentType', 'issuingCountryCode', 'documentNumber', 'issuedOn', 'expiresOn'],
    })
    expect(JSON.stringify(persisted[1])).not.toContain('44051401458')
    expect(afterMutation).toHaveBeenCalledWith({
      eventId: 'finoo_identities.identity.created',
      tenantId: '5164d495-1865-4738-b459-2783999a761d',
      organizationId: 'd0d98cb3-28cf-4376-a61c-d270020f166f',
      personId: 'ee823a18-e50c-4de4-9d71-4f516d7d754e',
      identityId: '4e5f6a45-e7fd-40df-85b5-ad8a6e82d5b5',
      changedFields: ['pesel', 'documentType', 'issuingCountryCode', 'documentNumber', 'issuedOn', 'expiresOn'],
      isComplete: true,
    })
    expect(JSON.stringify(afterMutation.mock.calls)).not.toContain('44051401458')
  })

  it('does not create identity data for a missing scoped Person', async () => {
    const persisted: unknown[] = []
    const em: Record<string, unknown> = {}
    Object.assign(em, {
      create: (entity: unknown, data: Record<string, unknown>) => entity === FinooIdentityAuditEntry
        ? { id: 'audit-entry-id', ...data }
        : { id: 'identity-id', ...data, updatedAt: new Date() },
      persist: (entity: unknown) => persisted.push(entity),
      findOne: jest.fn(async () => null),
      flush: jest.fn(async () => undefined),
      getConnection: () => ({ execute: jest.fn(async () => []) }),
      transactional: async (callback: (transactionalEm: unknown) => Promise<unknown>) => callback(em),
    })
    findOneWithDecryption.mockResolvedValue(null)
    const service = createFinooIdentityService({
      em: em as never,
      rbacService: { userHasAllFeatures: jest.fn(async () => true) } as never,
      encryptionService: encryptionService as never,
    })

    await expect(service.upsertForAuthorizedActor({
      scope: {
        actorUserId: '54af32b0-9209-48b2-a78d-13d2602ea741',
        tenantId: '5164d495-1865-4738-b459-2783999a761d',
        organizationId: 'd0d98cb3-28cf-4376-a61c-d270020f166f',
        personId: 'ee823a18-e50c-4de4-9d71-4f516d7d754e',
      },
      input: {
        pesel: '44051401458',
        documentType: null,
        issuingCountryCode: null,
        documentNumber: null,
        issuedOn: null,
        expiresOn: null,
      },
    })).rejects.toMatchObject({ status: 404, body: { error: 'person_not_found' } })
    expect(persisted).toHaveLength(0)
  })

  it('allows a technical source to create identity data only when no identity exists', async () => {
    const persisted: unknown[] = []
    const afterMutation = jest.fn(async () => undefined)
    const em: Record<string, unknown> = {}
    Object.assign(em, {
      create: (entity: unknown, data: Record<string, unknown>) => entity === FinooPersonIdentity
        ? {
            id: '4e5f6a45-e7fd-40df-85b5-ad8a6e82d5b5',
            ...data,
            updatedAt: new Date('2026-08-24T14:00:00.000Z'),
          }
        : { id: 'audit-entry-id', ...data },
      persist: (entity: unknown) => persisted.push(entity),
      flush: jest.fn(async () => undefined),
      getConnection: () => ({ execute: jest.fn(async () => []) }),
      transactional: async (callback: (transactionalEm: unknown) => Promise<unknown>) => callback(em),
    })
    findOneWithDecryption.mockImplementation(async (_em: unknown, entity: unknown) => (
      entity === CustomerEntity
        ? { id: 'ee823a18-e50c-4de4-9d71-4f516d7d754e', kind: 'person' }
        : null
    ))
    const service = createFinooIdentityService({
      em: em as never,
      rbacService: { userHasAllFeatures: jest.fn(async () => { throw new Error('technical imports do not use human RBAC') }) } as never,
      encryptionService: encryptionService as never,
      afterMutation,
    })

    const result = await service.createFromTechnicalImport({
      tenantId: '5164d495-1865-4738-b459-2783999a761d',
      organizationId: 'd0d98cb3-28cf-4376-a61c-d270020f166f',
      personId: 'ee823a18-e50c-4de4-9d71-4f516d7d754e',
      sourceModule: 'finoo_applications',
      sourceRecordId: 'c2a7bf6a-f08e-492b-913e-b523b9d47648',
      input: {
        pesel: '44051401458',
        documentType: 'identity_card',
        issuingCountryCode: 'PL',
        documentNumber: 'ABC123456',
        issuedOn: '2024-01-10',
        expiresOn: '2034-01-10',
      },
    })

    expect(result).toEqual({
      status: 'created',
      identityId: '4e5f6a45-e7fd-40df-85b5-ad8a6e82d5b5',
      isComplete: true,
    })
    expect(persisted[1]).toMatchObject({
      actorUserId: null,
      actorKind: 'system',
      operation: 'import',
      outcome: 'allowed',
    })
    expect(JSON.stringify(persisted[1])).not.toContain('44051401458')
    expect(afterMutation).toHaveBeenCalledWith(expect.objectContaining({
      eventId: 'finoo_identities.identity.created',
      personId: 'ee823a18-e50c-4de4-9d71-4f516d7d754e',
      identityId: '4e5f6a45-e7fd-40df-85b5-ad8a6e82d5b5',
      isComplete: true,
    }))
    expect(JSON.stringify(afterMutation.mock.calls)).not.toContain('44051401458')
  })

  it('rejects every technical source except the FINOO application projector before accessing storage', async () => {
    const service = createFinooIdentityService({
      em: {} as never,
      rbacService: { userHasAllFeatures: jest.fn() } as never,
      encryptionService: encryptionService as never,
    })

    await expect(service.createFromTechnicalImport({
      tenantId: '5164d495-1865-4738-b459-2783999a761d',
      organizationId: 'd0d98cb3-28cf-4376-a61c-d270020f166f',
      personId: 'ee823a18-e50c-4de4-9d71-4f516d7d754e',
      sourceModule: 'another_module',
      sourceRecordId: 'c2a7bf6a-f08e-492b-913e-b523b9d47648',
      input: { pesel: '44051401458' },
    } as never)).rejects.toMatchObject({ name: 'ZodError' })
    expect(encryptionService.getDek).not.toHaveBeenCalled()
  })

  it('creates a review conflict and never overwrites different existing identity data', async () => {
    const existingIdentity = {
      id: '4e5f6a45-e7fd-40df-85b5-ad8a6e82d5b5',
      tenantId: '5164d495-1865-4738-b459-2783999a761d',
      organizationId: 'd0d98cb3-28cf-4376-a61c-d270020f166f',
      personId: 'ee823a18-e50c-4de4-9d71-4f516d7d754e',
      pesel: '44051401458',
      documentType: 'identity_card',
      issuingCountryCode: 'PL',
      documentNumber: 'CURRENT123',
      issuedOn: '2024-01-10',
      expiresOn: '2034-01-10',
      isComplete: true,
      updatedAt: new Date('2026-08-24T14:00:00.000Z'),
      deletedAt: null,
    }
    const persisted: unknown[] = []
    const em: Record<string, unknown> = {}
    Object.assign(em, {
      create: (entity: unknown, data: Record<string, unknown>) => entity === FinooIdentityImportConflict
        ? { id: '1dc885ce-a2ce-4053-a069-e27ae0942327', ...data }
        : { id: 'audit-entry-id', ...data },
      persist: (entity: unknown) => persisted.push(entity),
      findOne: jest.fn(async () => null),
      flush: jest.fn(async () => undefined),
      getConnection: () => ({ execute: jest.fn(async () => []) }),
      transactional: async (callback: (transactionalEm: unknown) => Promise<unknown>) => callback(em),
    })
    findOneWithDecryption.mockImplementation(async (_em: unknown, entity: unknown) => {
      if (entity === CustomerEntity) return { id: existingIdentity.personId, kind: 'person' }
      if (entity === FinooPersonIdentity) return existingIdentity
      return null
    })
    const service = createFinooIdentityService({
      em: em as never,
      rbacService: { userHasAllFeatures: jest.fn(async () => true) } as never,
      encryptionService: encryptionService as never,
    })

    const result = await service.createFromTechnicalImport({
      tenantId: existingIdentity.tenantId,
      organizationId: existingIdentity.organizationId,
      personId: existingIdentity.personId,
      sourceModule: 'finoo_applications',
      sourceRecordId: 'c2a7bf6a-f08e-492b-913e-b523b9d47648',
      input: {
        pesel: existingIdentity.pesel,
        documentType: 'identity_card',
        issuingCountryCode: 'PL',
        documentNumber: 'CANDIDATE456',
        issuedOn: '2024-01-10',
        expiresOn: '2034-01-10',
      },
    })

    expect(result).toEqual({
      status: 'conflict',
      identityId: existingIdentity.id,
      isComplete: true,
      conflictId: '1dc885ce-a2ce-4053-a069-e27ae0942327',
    })
    expect(existingIdentity.documentNumber).toBe('CURRENT123')
    expect(persisted[0]).toMatchObject({
      candidateDocumentNumber: 'CANDIDATE456',
      changedFields: ['documentNumber'],
      state: 'open',
    })
    expect(persisted[1]).toMatchObject({ operation: 'import', outcome: 'allowed', changedFields: ['documentNumber'] })
    expect(JSON.stringify(persisted[1])).not.toContain('CANDIDATE456')
  })

  it('lists value-free audit metadata for an authorized actor and audits that read', async () => {
    const persisted: unknown[] = []
    const em = {
      create: (_entity: unknown, data: Record<string, unknown>) => ({ id: 'new-audit-id', ...data }),
      persist: (entity: unknown) => persisted.push(entity),
      flush: jest.fn(async () => undefined),
      findAndCount: jest.fn(async () => [[{
        id: '13d9d71d-b414-4b06-bdb6-815e16da86bd',
        actorUserId: '54af32b0-9209-48b2-a78d-13d2602ea741',
        actorKind: 'user',
        operation: 'update',
        outcome: 'allowed',
        changedFields: ['documentNumber'],
        createdAt: new Date('2026-08-24T14:00:00.000Z'),
      }], 1]),
    }
    findOneWithDecryption.mockImplementation(async (_em: unknown, entity: unknown) => (
      entity === CustomerEntity ? { id: 'ee823a18-e50c-4de4-9d71-4f516d7d754e', kind: 'person' } : null
    ))
    const service = createFinooIdentityService({
      em: em as never,
      rbacService: { userHasAllFeatures: jest.fn(async () => true) } as never,
      encryptionService: encryptionService as never,
    })

    const result = await service.listAuditForAuthorizedActor({
      scope: {
        actorUserId: '54af32b0-9209-48b2-a78d-13d2602ea741',
        tenantId: '5164d495-1865-4738-b459-2783999a761d',
        organizationId: 'd0d98cb3-28cf-4376-a61c-d270020f166f',
        personId: 'ee823a18-e50c-4de4-9d71-4f516d7d754e',
      },
      page: 1,
      pageSize: 50,
    })

    expect(result).toEqual({
      items: [{
        id: '13d9d71d-b414-4b06-bdb6-815e16da86bd',
        actorUserId: '54af32b0-9209-48b2-a78d-13d2602ea741',
        actorKind: 'user',
        operation: 'update',
        outcome: 'allowed',
        changedFields: ['documentNumber'],
        createdAt: '2026-08-24T14:00:00.000Z',
      }],
      page: 1,
      pageSize: 50,
      total: 1,
    })
    expect(persisted[0]).toMatchObject({ operation: 'read', outcome: 'allowed' })
    expect(JSON.stringify(result)).not.toContain('44051401458')
  })

  it('lists scoped decrypted import conflicts only after view authorization', async () => {
    const persisted: unknown[] = []
    const em = {
      create: (_entity: unknown, data: Record<string, unknown>) => ({ id: 'audit-entry-id', ...data }),
      persist: (entity: unknown) => persisted.push(entity),
      flush: jest.fn(async () => undefined),
    }
    const identity = {
      id: '4e5f6a45-e7fd-40df-85b5-ad8a6e82d5b5',
      personId: 'ee823a18-e50c-4de4-9d71-4f516d7d754e',
      pesel: '44051401458',
      documentType: 'identity_card',
      issuingCountryCode: 'PL',
      documentNumber: 'CURRENT123',
      issuedOn: '2024-01-10',
      expiresOn: '2034-01-10',
      updatedAt: new Date('2026-08-24T14:00:00.000Z'),
    }
    const conflict = {
      id: '1dc885ce-a2ce-4053-a069-e27ae0942327',
      sourceModule: 'finoo_applications',
      sourceRecordId: 'c2a7bf6a-f08e-492b-913e-b523b9d47648',
      candidatePesel: '44051401458',
      candidateDocumentType: 'identity_card',
      candidateIssuingCountryCode: 'PL',
      candidateDocumentNumber: 'CANDIDATE456',
      candidateIssuedOn: '2024-01-10',
      candidateExpiresOn: '2034-01-10',
      changedFields: ['documentNumber'],
      state: 'open',
      createdAt: new Date('2026-08-24T14:05:00.000Z'),
      updatedAt: new Date('2026-08-24T14:05:00.000Z'),
    }
    findOneWithDecryption.mockImplementation(async (_em: unknown, entity: unknown) => {
      if (entity === CustomerEntity) return { id: identity.personId, kind: 'person' }
      if (entity === FinooPersonIdentity) return identity
      return null
    })
    findAndCountWithDecryption.mockResolvedValue([[conflict], 1])
    const service = createFinooIdentityService({
      em: em as never,
      rbacService: { userHasAllFeatures: jest.fn(async () => true) } as never,
      encryptionService: encryptionService as never,
    })

    const result = await service.listConflictsForAuthorizedActor({
      scope: {
        actorUserId: '54af32b0-9209-48b2-a78d-13d2602ea741',
        tenantId: '5164d495-1865-4738-b459-2783999a761d',
        organizationId: 'd0d98cb3-28cf-4376-a61c-d270020f166f',
        personId: identity.personId,
      },
      page: 1,
      pageSize: 50,
    })

    expect(result.items[0]).toMatchObject({
      id: conflict.id,
      current: { documentNumber: 'CURRENT123', updatedAt: '2026-08-24T14:00:00.000Z' },
      candidate: { documentNumber: 'CANDIDATE456' },
      changedFields: ['documentNumber'],
      updatedAt: '2026-08-24T14:05:00.000Z',
    })
    expect(persisted[0]).toMatchObject({ operation: 'review_conflict', outcome: 'allowed' })
    expect(findAndCountWithDecryption).toHaveBeenCalledWith(
      em,
      FinooIdentityImportConflict,
      expect.objectContaining({ state: 'open', personId: identity.personId }),
      expect.objectContaining({ limit: 50, offset: 0 }),
      expect.objectContaining({ tenantId: '5164d495-1865-4738-b459-2783999a761d' }),
    )
  })

  it('replaces identity data from a reviewed conflict and clears every candidate value', async () => {
    const identity = {
      id: '4e5f6a45-e7fd-40df-85b5-ad8a6e82d5b5',
      personId: 'ee823a18-e50c-4de4-9d71-4f516d7d754e',
      pesel: '44051401458',
      documentType: 'identity_card',
      issuingCountryCode: 'PL',
      documentNumber: 'CURRENT123',
      issuedOn: '2024-01-10',
      expiresOn: '2034-01-10',
      isComplete: true,
      fieldStatuses: {},
      updatedAt: new Date('2026-08-24T14:00:00.000Z'),
    }
    const conflict = {
      id: '1dc885ce-a2ce-4053-a069-e27ae0942327',
      personId: identity.personId,
      candidatePesel: '44051401458',
      candidateDocumentType: 'identity_card',
      candidateIssuingCountryCode: 'PL',
      candidateDocumentNumber: 'CANDIDATE456',
      candidateIssuedOn: '2024-01-10',
      candidateExpiresOn: '2034-01-10',
      changedFields: ['documentNumber'],
      state: 'open',
      updatedAt: new Date('2026-08-24T14:05:00.000Z'),
    }
    const persisted: unknown[] = []
    const em: Record<string, unknown> = {}
    Object.assign(em, {
      create: (_entity: unknown, data: Record<string, unknown>) => ({ id: 'audit-entry-id', ...data }),
      persist: (entity: unknown) => persisted.push(entity),
      flush: jest.fn(async () => undefined),
      getConnection: () => ({ execute: jest.fn(async () => []) }),
      transactional: async (callback: (transactionalEm: unknown) => Promise<unknown>) => callback(em),
    })
    findOneWithDecryption.mockImplementation(async (_em: unknown, entity: unknown) => {
      if (entity === FinooIdentityImportConflict) return conflict
      if (entity === FinooPersonIdentity) return identity
      return null
    })
    const service = createFinooIdentityService({
      em: em as never,
      rbacService: { userHasAllFeatures: jest.fn(async () => true) } as never,
      encryptionService: encryptionService as never,
    })

    const result = await service.resolveConflictForAuthorizedActor({
      scope: {
        actorUserId: '54af32b0-9209-48b2-a78d-13d2602ea741',
        tenantId: '5164d495-1865-4738-b459-2783999a761d',
        organizationId: 'd0d98cb3-28cf-4376-a61c-d270020f166f',
      },
      conflictId: conflict.id,
      input: {
        action: 'replace',
        updatedAt: conflict.updatedAt.toISOString(),
        identityUpdatedAt: identity.updatedAt.toISOString(),
      },
    })

    expect(result).toMatchObject({ state: 'resolved', identityId: identity.id, isComplete: true })
    expect(identity.documentNumber).toBe('CANDIDATE456')
    expect(conflict).toMatchObject({
      state: 'resolved',
      candidatePesel: null,
      candidateDocumentType: null,
      candidateIssuingCountryCode: null,
      candidateDocumentNumber: null,
      candidateIssuedOn: null,
      candidateExpiresOn: null,
    })
    expect(persisted[0]).toMatchObject({
      operation: 'resolve_conflict',
      outcome: 'allowed',
      changedFields: ['documentNumber'],
    })
    expect(JSON.stringify(persisted[0])).not.toContain('CANDIDATE456')
  })

  it('fails closed before erasure when the application retention port is unavailable', async () => {
    const transactional = jest.fn()
    const service = createFinooIdentityService({
      em: { transactional } as never,
      rbacService: { userHasAllFeatures: jest.fn() } as never,
      encryptionService: encryptionService as never,
    })

    await expect(service.anonymizeAndDeleteForPerson({
      tenantId: '5164d495-1865-4738-b459-2783999a761d',
      organizationId: 'd0d98cb3-28cf-4376-a61c-d270020f166f',
      personId: 'ee823a18-e50c-4de4-9d71-4f516d7d754e',
      systemActor: true,
    })).rejects.toMatchObject({ status: 503, body: { error: 'identity_retention_unavailable' } })
    expect(transactional).not.toHaveBeenCalled()
  })

  it('erases all Person-linked identity copies and anonymizes audit links through one system seam', async () => {
    const persisted: unknown[] = []
    const afterMutation = jest.fn(async () => undefined)
    const execute = jest.fn(async (query: string) => {
      if (query.includes('pg_advisory_xact_lock')) return []
      if (query.includes('finoo_identity_import_conflicts')) return [{ id: 'conflict-id' }]
      if (query.includes('finoo_person_identities')) return [{ id: 'identity-id' }]
      if (query.includes('custom_field_values')) return [{ id: 'legacy-value-id' }]
      if (query.includes('update finoo_identity_audit_entries')) return [{ id: 'audit-id-1' }, { id: 'audit-id-2' }]
      throw new Error(`Unexpected SQL: ${query}`)
    })
    const em: Record<string, unknown> = {
      getConnection: () => ({ execute }),
      create: (_entity: unknown, data: Record<string, unknown>) => ({ id: 'erase-audit-id', ...data }),
      persist: (entity: unknown) => persisted.push(entity),
      flush: jest.fn(async () => undefined),
    }
    em.transactional = async (callback: (transactionalEm: unknown) => Promise<unknown>) => callback(em)
    const erasePersonIdentityCopies = jest.fn(async () => ({ intakesRedacted: 3, bindingsDeleted: 1 }))
    const service = createFinooIdentityService({
      em: em as never,
      rbacService: { userHasAllFeatures: jest.fn() } as never,
      encryptionService: encryptionService as never,
      resolveApplicationIdentityRetention: () => ({ erasePersonIdentityCopies }) as never,
      afterMutation,
    })

    const result = await service.anonymizeAndDeleteForPerson({
      tenantId: '5164d495-1865-4738-b459-2783999a761d',
      organizationId: 'd0d98cb3-28cf-4376-a61c-d270020f166f',
      personId: 'ee823a18-e50c-4de4-9d71-4f516d7d754e',
      systemActor: true,
    })

    expect(result).toEqual({
      identitiesDeleted: 1,
      conflictsDeleted: 1,
      legacyValuesDeleted: 1,
      auditEntriesAnonymized: 2,
      applicationIntakesRedacted: 3,
      applicationBindingsDeleted: 1,
    })
    expect(erasePersonIdentityCopies).toHaveBeenCalledWith(expect.objectContaining({
      em,
      personId: 'ee823a18-e50c-4de4-9d71-4f516d7d754e',
    }))
    expect(persisted[0]).toMatchObject({
      personId: null,
      operation: 'erase',
      outcome: 'allowed',
    })
    expect(JSON.stringify(result)).not.toContain('44051401458')
    expect(afterMutation).toHaveBeenCalledWith({
      eventId: 'finoo_identities.identity.erased',
      tenantId: '5164d495-1865-4738-b459-2783999a761d',
      organizationId: 'd0d98cb3-28cf-4376-a61c-d270020f166f',
      personId: 'ee823a18-e50c-4de4-9d71-4f516d7d754e',
    })
  })
})
