import {
  FINOO_APPLICATION_NON_IDENTITY_SENSITIVE_FIELD_SPECS,
  FINOO_APPLICATION_REQUIRED_ENCRYPTION_MAPS,
} from '../sensitive-fields'
import { requireSensitiveFieldsEncrypted } from '../projector'

const tenantId = '5164d495-1865-4738-b459-2783999a761d'
const organizationId = 'd0d98cb3-28cf-4376-a61c-d270020f166f'

function nonIdentityDefinitions() {
  return FINOO_APPLICATION_NON_IDENTITY_SENSITIVE_FIELD_SPECS.map((spec) => ({
    ...spec,
    configJson: { encrypted: true },
  }))
}

function encryptionService() {
  return {
    getEncryptedFieldNames: jest.fn(async (entityId: string) => (
      FINOO_APPLICATION_REQUIRED_ENCRYPTION_MAPS.find((entry) => entry.entityId === entityId)?.fields ?? []
    )),
  }
}

describe('FINOO application identity cutover', () => {
  it('never reads legacy definitions because new projector writes use only the identity service', async () => {
    const em = {
      find: jest.fn().mockResolvedValueOnce(nonIdentityDefinitions()),
    }

    await expect(requireSensitiveFieldsEncrypted(
      em as never,
      encryptionService() as never,
      { tenantId, organizationId },
    )).resolves.toBeUndefined()
    expect(em.find).toHaveBeenCalledTimes(1)
  })
})
