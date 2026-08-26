import type { EntityManager } from '@mikro-orm/postgresql'
import type { ResponseEnricher } from '@open-mercato/shared/lib/crud/response-enricher'
import { FinooPersonIdentity } from './entities'
import { sanitizeIdentityFieldStatuses, type IdentityFieldStatuses } from '../lib/identity-domain'

type PersonRecord = Record<string, unknown> & { id: string }

const missingStatuses: IdentityFieldStatuses = {
  pesel: 'missing',
  documentType: 'missing',
  issuingCountryCode: 'missing',
  documentNumber: 'missing',
  issuedOn: 'missing',
  expiresOn: 'missing',
}

const completenessEnricher: ResponseEnricher<PersonRecord> = {
  id: 'finoo_identities.person-completeness',
  targetEntity: 'customers.person',
  priority: 20,
  timeout: 2000,
  cacheableOnListHit: false,
  async enrichOne(record, context) {
    const identity = await (context.em as EntityManager).findOne(
      FinooPersonIdentity,
      {
        tenantId: context.tenantId,
        organizationId: context.organizationId,
        personId: record.id,
        deletedAt: null,
      },
      { fields: ['personId', 'isComplete', 'fieldStatuses'] },
    )
    return {
      ...record,
      _finooIdentities: {
        isComplete: identity?.isComplete ?? false,
        statuses: identity ? sanitizeIdentityFieldStatuses(identity.fieldStatuses) : missingStatuses,
      },
    }
  },
  async enrichMany(records, context) {
    if (records.length === 0) return records
    const identities = await (context.em as EntityManager).find(
      FinooPersonIdentity,
      {
        tenantId: context.tenantId,
        organizationId: context.organizationId,
        personId: { $in: records.map((record) => record.id) },
        deletedAt: null,
      },
      { fields: ['personId', 'isComplete'] },
    )
    const completeByPersonId = new Map(identities.map((identity) => [identity.personId, identity.isComplete]))
    return records.map((record) => ({
      ...record,
      _finooIdentities: {
        isComplete: completeByPersonId.get(record.id) ?? false,
      },
    }))
  },
}

export const enrichers: ResponseEnricher[] = [completenessEnricher]
