import type { EntityManager } from '@mikro-orm/postgresql'
import type { TenantDataEncryptionService } from '@open-mercato/shared/lib/encryption/tenantDataEncryptionService'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import {
  FinooApplicationIdentityBinding,
  FinooApplicationIntake,
  FinooApplicationProjection,
} from '../data/entities'

const IDENTITY_PAYLOAD_KEYS = [
  'pesel',
  'idType',
  'idCard',
  'idCardIssued',
  'idCardExpiry',
  'passport',
  'passportCountryCode',
  'passportIssued',
  'passportExpiry',
  'digitCard',
  'digitCardIssued',
  'digitCardExpiry',
  'country',
] as const

export async function eraseFinooApplicationIdentityCopies(input: {
  em: EntityManager
  tenantId: string
  organizationId: string
  personId: string
  encryptionService: Pick<TenantDataEncryptionService, 'isEnabled' | 'getDek' | 'getEncryptedFieldNames'>
}): Promise<{ intakesRedacted: number; bindingsDeleted: number }> {
  const scope = { tenantId: input.tenantId, organizationId: input.organizationId }
  if (!input.encryptionService.isEnabled() || !Boolean((await input.encryptionService.getDek(input.tenantId))?.key)) {
    throw new Error('identity_retention_encryption_unavailable')
  }
  const encryptedFields = await input.encryptionService.getEncryptedFieldNames(
    'finoo_applications:finoo_application_intake',
    input.tenantId,
    input.organizationId,
  )
  if (!encryptedFields.includes('payload_json')) throw new Error('identity_retention_encryption_unavailable')
  const bindings = await input.em.find(FinooApplicationIdentityBinding, {
    ...scope,
    identityKind: 'pesel',
    $or: [
      { customerEntityId: input.personId },
      { reservedEntityId: input.personId },
    ],
  }, { fields: ['id', 'projectionId'] })
  const bindingProjectionIds = [...new Set(bindings.flatMap((binding) => binding.projectionId ? [binding.projectionId] : []))]
  const projections = await input.em.find(FinooApplicationProjection, {
    ...scope,
    $or: [
      { applicantEntityId: input.personId },
      ...(bindingProjectionIds.length > 0 ? [{ id: { $in: bindingProjectionIds } }] : []),
    ],
  }, { fields: ['id', 'externalLeadId'] })
  const externalLeadIds = [...new Set(projections.map((projection) => projection.externalLeadId))]
  let intakesRedacted = 0
  if (externalLeadIds.length > 0) {
    const intakes = await findWithDecryption(
      input.em,
      FinooApplicationIntake,
      { ...scope, externalLeadId: { $in: externalLeadIds } },
      undefined,
      scope,
    )
    for (const intake of intakes) {
      if (!intake.payloadJson) continue
      if (typeof intake.payloadJson !== 'object' || Array.isArray(intake.payloadJson)) {
        throw new Error('identity_retention_payload_unreadable')
      }
      const payload = { ...intake.payloadJson } as Record<string, unknown>
      let changed = false
      for (const key of IDENTITY_PAYLOAD_KEYS) {
        if (!(key in payload)) continue
        delete payload[key]
        changed = true
      }
      if (!changed) continue
      intake.payloadJson = payload as typeof intake.payloadJson
      input.em.persist(intake)
      intakesRedacted += 1
    }
  }
  const bindingsDeleted = await input.em.nativeDelete(FinooApplicationIdentityBinding, {
    ...scope,
    identityKind: 'pesel',
    $or: [
      { customerEntityId: input.personId },
      { reservedEntityId: input.personId },
    ],
  })
  return { intakesRedacted, bindingsDeleted }
}
