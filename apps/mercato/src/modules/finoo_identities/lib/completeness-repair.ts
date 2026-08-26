import { LockMode, type EntityManager } from '@mikro-orm/postgresql'
import { hashForLookup } from '@open-mercato/shared/lib/encryption/aes'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import type { TenantDataEncryptionService } from '@open-mercato/shared/lib/encryption/tenantDataEncryptionService'
import { FinooIdentityAuditEntry, FinooPersonIdentity } from '../data/entities'
import { defaultEncryptionMaps } from '../encryption'
import {
  computeIdentityCompleteness,
  fixedIdentityIssuingCountryCode,
} from './identity-domain'

export type IdentityCompletenessRepairMode = 'dry-run' | 'apply'

export type IdentityCompletenessRepairReport = {
  mode: IdentityCompletenessRepairMode
  scanned: number
  countryConflicts: number
  countriesNormalized: number
  completenessUpdated: number
  wouldNormalizeCountries: number
  wouldUpdateCompleteness: number
}

type IdentityCompletenessRepairScope = {
  tenantId: string
  organizationId: string
}

type IdentityCompletenessRepairEncryption = Pick<
  TenantDataEncryptionService,
  'isEnabled' | 'getDek' | 'getEncryptedFieldNames'
>

async function requireIdentityEncryption(
  encryptionService: IdentityCompletenessRepairEncryption,
  scope: IdentityCompletenessRepairScope,
): Promise<void> {
  if (!encryptionService.isEnabled()) throw new Error('identity_encryption_unavailable')
  const dek = await encryptionService.getDek(scope.tenantId)
  if (!dek?.key) throw new Error('identity_encryption_unavailable')
  const identityMap = defaultEncryptionMaps.find(
    (map) => map.entityId === 'finoo_identities:finoo_person_identity',
  )
  if (!identityMap) throw new Error('identity_encryption_unavailable')
  const encryptedFields = await encryptionService.getEncryptedFieldNames(
    identityMap.entityId,
    scope.tenantId,
    scope.organizationId,
  )
  if (!identityMap.fields.every(({ field }) => encryptedFields.includes(field))) {
    throw new Error('identity_encryption_unavailable')
  }
}

function sameStatuses(left: FinooPersonIdentity['fieldStatuses'], right: FinooPersonIdentity['fieldStatuses']): boolean {
  return left.pesel === right.pesel
    && left.documentType === right.documentType
    && left.issuingCountryCode === right.issuingCountryCode
    && left.documentNumber === right.documentNumber
    && left.issuedOn === right.issuedOn
    && left.expiresOn === right.expiresOn
}

export async function repairIdentityCompleteness(input: {
  em: EntityManager
  encryptionService: IdentityCompletenessRepairEncryption
  scope: IdentityCompletenessRepairScope
  mode: IdentityCompletenessRepairMode
  batchSize?: number
}): Promise<IdentityCompletenessRepairReport> {
  await requireIdentityEncryption(input.encryptionService, input.scope)
  const batchSize = Math.min(Math.max(input.batchSize ?? 100, 1), 500)
  const report: IdentityCompletenessRepairReport = {
    mode: input.mode,
    scanned: 0,
    countryConflicts: 0,
    countriesNormalized: 0,
    completenessUpdated: 0,
    wouldNormalizeCountries: 0,
    wouldUpdateCompleteness: 0,
  }
  let afterId: string | null = null

  while (true) {
    const processPage = async (em: EntityManager): Promise<string | null> => {
      const identities = await findWithDecryption(
        em,
        FinooPersonIdentity,
        {
          ...input.scope,
          deletedAt: null,
          ...(afterId ? { id: { $gt: afterId } } : {}),
        },
        {
          orderBy: { id: 'ASC' },
          limit: batchSize,
          ...(input.mode === 'apply' ? { lockMode: LockMode.PESSIMISTIC_WRITE } : {}),
        },
        input.scope,
      )
      if (identities.length === 0) return null

      let pageChanged = false
      for (const identity of identities) {
        report.scanned += 1
        const fixedCountryCode = fixedIdentityIssuingCountryCode(identity.documentType)
        const normalizedExistingCountry = identity.issuingCountryCode?.trim().toUpperCase() || null
        const countryConflict = fixedCountryCode !== null
          && normalizedExistingCountry !== null
          && normalizedExistingCountry !== fixedCountryCode
        const shouldNormalizeCountry = fixedCountryCode !== null
          && !countryConflict
          && identity.issuingCountryCode !== fixedCountryCode

        if (countryConflict) report.countryConflicts += 1

        const completeness = computeIdentityCompleteness({
          ...identity,
          issuingCountryCode: shouldNormalizeCountry ? fixedCountryCode : identity.issuingCountryCode,
        })
        const shouldUpdateCompleteness = identity.isComplete !== completeness.isComplete
          || !sameStatuses(identity.fieldStatuses, completeness.statuses)

        if (input.mode === 'dry-run') {
          if (shouldNormalizeCountry) report.wouldNormalizeCountries += 1
          if (shouldUpdateCompleteness) report.wouldUpdateCompleteness += 1
          continue
        }

        if (shouldNormalizeCountry) {
          identity.issuingCountryCode = fixedCountryCode
          em.persist(em.create(FinooIdentityAuditEntry, {
            ...input.scope,
            actorUserId: null,
            actorKind: 'system',
            personId: identity.personId,
            subjectDigest: hashForLookup(
              identity.personId,
              `finoo_identity_audit:${input.scope.tenantId}:${input.scope.organizationId}`,
            ),
            operation: 'update',
            outcome: 'allowed',
            changedFields: ['issuingCountryCode'],
          }))
          report.countriesNormalized += 1
          pageChanged = true
        }
        if (shouldUpdateCompleteness) {
          identity.isComplete = completeness.isComplete
          identity.fieldStatuses = completeness.statuses
          report.completenessUpdated += 1
          pageChanged = true
        }
        if (shouldNormalizeCountry || shouldUpdateCompleteness) em.persist(identity)
      }
      if (pageChanged) await em.flush()
      return identities.at(-1)?.id ?? null
    }

    const nextAfterId = input.mode === 'apply'
      ? await input.em.transactional(processPage)
      : await processPage(input.em)
    if (!nextAfterId) break
    afterId = nextAfterId
  }

  return report
}
