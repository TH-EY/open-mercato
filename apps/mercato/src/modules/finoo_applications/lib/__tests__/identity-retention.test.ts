import { FinooApplicationIdentityBinding } from '../../data/entities'
import { eraseFinooApplicationIdentityCopies } from '../identity-retention'

const findWithDecryption = jest.fn()

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findWithDecryption: (...args: unknown[]) => findWithDecryption(...args),
}))

describe('FINOO application identity retention port', () => {
  const encryptionService = {
    isEnabled: jest.fn(() => true),
    getDek: jest.fn(async () => ({ key: Buffer.alloc(32) })),
    getEncryptedFieldNames: jest.fn(async () => ['payload_json']),
  }

  beforeEach(() => {
    findWithDecryption.mockReset()
    encryptionService.isEnabled.mockReset().mockReturnValue(true)
    encryptionService.getDek.mockReset().mockResolvedValue({ key: Buffer.alloc(32) })
    encryptionService.getEncryptedFieldNames.mockReset().mockResolvedValue(['payload_json'])
  })

  it('redacts identity fields from linked intakes and deletes the PESEL binding', async () => {
    const intake = {
      payloadJson: {
        name: 'Jan',
        pesel: '44051401458',
        idType: 'IDCARD',
        idCard: 'ABC123456',
        idCardIssued: '2024-01-10',
        idCardExpiry: '2034-01-10',
        country: 'PL',
      },
    }
    const persisted: unknown[] = []
    const em = {
      find: jest.fn()
        .mockResolvedValueOnce([{ id: 'binding-id', projectionId: 'projection-id' }])
        .mockResolvedValueOnce([{ id: 'projection-id', externalLeadId: 'lead-12345678' }]),
      persist: (entity: unknown) => persisted.push(entity),
      nativeDelete: jest.fn(async () => 1),
    }
    findWithDecryption.mockResolvedValue([intake])

    const result = await eraseFinooApplicationIdentityCopies({
      em: em as never,
      tenantId: '5164d495-1865-4738-b459-2783999a761d',
      organizationId: 'd0d98cb3-28cf-4376-a61c-d270020f166f',
      personId: 'ee823a18-e50c-4de4-9d71-4f516d7d754e',
      encryptionService,
    })

    expect(result).toEqual({ intakesRedacted: 1, bindingsDeleted: 1 })
    expect(intake.payloadJson).toEqual({ name: 'Jan' })
    expect(persisted).toEqual([intake])
    expect(em.nativeDelete).toHaveBeenCalledWith(FinooApplicationIdentityBinding, expect.objectContaining({
      identityKind: 'pesel',
      $or: expect.arrayContaining([
        { customerEntityId: 'ee823a18-e50c-4de4-9d71-4f516d7d754e' },
        { reservedEntityId: 'ee823a18-e50c-4de4-9d71-4f516d7d754e' },
      ]),
    }))
  })

  it('follows a reserved Person id when projection finalization was interrupted', async () => {
    const intake = { payloadJson: { pesel: '44051401458', name: 'Jan' } }
    const em = {
      find: jest.fn()
        .mockResolvedValueOnce([{ id: 'binding-id', projectionId: 'projection-id' }])
        .mockResolvedValueOnce([{ id: 'projection-id', externalLeadId: 'lead-12345678' }]),
      persist: jest.fn(),
      nativeDelete: jest.fn(async () => 1),
    }
    findWithDecryption.mockResolvedValue([intake])

    await eraseFinooApplicationIdentityCopies({
      em: em as never,
      tenantId: '5164d495-1865-4738-b459-2783999a761d',
      organizationId: 'd0d98cb3-28cf-4376-a61c-d270020f166f',
      personId: 'ee823a18-e50c-4de4-9d71-4f516d7d754e',
      encryptionService,
    })

    expect(em.find.mock.calls[0]?.[1]).toMatchObject({
      identityKind: 'pesel',
      $or: expect.arrayContaining([
        { reservedEntityId: 'ee823a18-e50c-4de4-9d71-4f516d7d754e' },
      ]),
    })
    expect(intake.payloadJson).toEqual({ name: 'Jan' })
  })

  it('fails closed when an intake payload cannot be proven decrypted', async () => {
    const em = {
      find: jest.fn()
        .mockResolvedValueOnce([{ id: 'binding-id', projectionId: 'projection-id' }])
        .mockResolvedValueOnce([{ id: 'projection-id', externalLeadId: 'lead-12345678' }]),
      persist: jest.fn(),
      nativeDelete: jest.fn(),
    }
    findWithDecryption.mockResolvedValue([{ payloadJson: 'ciphertext-envelope:v1' }])

    await expect(eraseFinooApplicationIdentityCopies({
      em: em as never,
      tenantId: '5164d495-1865-4738-b459-2783999a761d',
      organizationId: 'd0d98cb3-28cf-4376-a61c-d270020f166f',
      personId: 'ee823a18-e50c-4de4-9d71-4f516d7d754e',
      encryptionService,
    })).rejects.toThrow('identity_retention_payload_unreadable')
    expect(em.nativeDelete).not.toHaveBeenCalled()
  })

  it('does not follow a representative email binding to the applicant intake', async () => {
    const em = {
      find: jest.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]),
      persist: jest.fn(),
      nativeDelete: jest.fn(async () => 0),
    }

    const result = await eraseFinooApplicationIdentityCopies({
      em: em as never,
      tenantId: '5164d495-1865-4738-b459-2783999a761d',
      organizationId: 'd0d98cb3-28cf-4376-a61c-d270020f166f',
      personId: 'ee823a18-e50c-4de4-9d71-4f516d7d754e',
      encryptionService,
    })

    expect(result).toEqual({ intakesRedacted: 0, bindingsDeleted: 0 })
    expect(em.find.mock.calls[0]?.[1]).toMatchObject({ identityKind: 'pesel' })
    expect(em.find.mock.calls[1]?.[1]).toMatchObject({
      $or: [{ applicantEntityId: 'ee823a18-e50c-4de4-9d71-4f516d7d754e' }],
    })
    expect(findWithDecryption).not.toHaveBeenCalled()
    expect(em.persist).not.toHaveBeenCalled()
    expect(em.nativeDelete).toHaveBeenCalledWith(FinooApplicationIdentityBinding, expect.objectContaining({
      identityKind: 'pesel',
    }))
  })
})
