import { QueryOrder, type EntityManager, type FilterQuery } from '@mikro-orm/postgresql'
import { DictionaryEntry } from '@open-mercato/core/modules/dictionaries/data/entities'
import { CustomFieldDef } from '@open-mercato/core/modules/entities/data/entities'
import {
  CustomerCompanyProfile,
  CustomerDeal,
  CustomerDealCompanyLink,
  CustomerDealPersonLink,
  CustomerEntity,
  CustomerInteraction,
  CustomerPersonProfile,
} from '@open-mercato/core/modules/customers/data/entities'
import { loadCustomFieldValues } from '@open-mercato/shared/lib/crud/custom-fields'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import type { FinooIntermediaryAssignment } from '../data/entities'

type ScopedDefinition = Pick<CustomFieldDef, 'id' | 'tenantId' | 'organizationId'>
type DatedLink = { id: string; createdAt: Date }

export type PortalDealProjection = {
  id: string
  assignmentId: string
  updatedAt: string
  companyName: string | null
  companyPhone: string | null
  personMobile: string | null
  personEmail: string | null
  turnover: number | null
  businessStartDate: string | null
  arrears: boolean | null
  industry: string | null
  partnerStatus: FinooIntermediaryAssignment['partnerStatus']
}

export type PortalActivityProjection = {
  id: string
  type: string
  occurredAt: string | null
  direction: null
  summary: string
}

export function selectOldestCompanyLink<T extends DatedLink>(links: T[]): T | null {
  return [...links].sort((left, right) => {
    const byDate = left.createdAt.getTime() - right.createdAt.getTime()
    return byDate || left.id.localeCompare(right.id)
  })[0] ?? null
}

export function selectScopedDefinition<T extends ScopedDefinition>(
  definitions: T[],
  tenantId: string,
  organizationId: string,
): T | null {
  return definitions
    .filter((definition) => (
      (definition.tenantId == null || definition.tenantId === tenantId)
      && (definition.organizationId == null || definition.organizationId === organizationId)
    ))
    .sort((left, right) => {
      const leftScore = left.organizationId ? 2 : left.tenantId ? 1 : 0
      const rightScore = right.organizationId ? 2 : right.tenantId ? 1 : 0
      return rightScore - leftScore
    })[0] ?? null
}

export function sanitizeActivitySummary(value: string | null | undefined): string {
  return (value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300)
}

export function readLoadedCustomFieldValue(
  values: Record<string, Record<string, unknown>>,
  recordId: string,
  fieldKey: string,
): unknown {
  return values[recordId]?.[`cf_${fieldKey}`]
}

function operationalConfigurationError(): CrudHttpError {
  return new CrudHttpError(500, { error: 'Intermediary portal configuration is incomplete' })
}

async function requireDefinition(
  em: EntityManager,
  input: {
    entityId: string
    key: string
    expectedKind: string
    tenantId: string
    organizationId: string
  },
) {
  const definitions = await em.find(CustomFieldDef, {
    entityId: input.entityId,
    key: input.key,
    isActive: true,
    deletedAt: null,
    $or: [
      { tenantId: input.tenantId, organizationId: input.organizationId },
      { tenantId: input.tenantId, organizationId: null },
      { tenantId: null, organizationId: null },
    ],
  } as FilterQuery<CustomFieldDef>)
  const definition = selectScopedDefinition(definitions, input.tenantId, input.organizationId)
  if (!definition || definition.kind !== input.expectedKind) throw operationalConfigurationError()
  return definition
}

function recordScope(ids: string[], scopeId: string): Record<string, string> {
  return Object.fromEntries(ids.map((id) => [id, scopeId]))
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function readDictionaryId(definition: CustomFieldDef): string {
  const config = definition.configJson
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw operationalConfigurationError()
  const dictionaryId = (config as Record<string, unknown>).dictionaryId
  if (typeof dictionaryId !== 'string' || dictionaryId.length === 0) throw operationalConfigurationError()
  return dictionaryId
}

export async function buildPortalDealProjections(
  em: EntityManager,
  assignments: FinooIntermediaryAssignment[],
  scope: { tenantId: string; organizationId: string },
): Promise<PortalDealProjection[]> {
  if (assignments.length === 0) return []
  const dealIds = assignments.map((assignment) => assignment.dealId)
  const deals = await em.find(CustomerDeal, {
    id: { $in: dealIds },
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    deletedAt: null,
  } as FilterQuery<CustomerDeal>)
  const dealById = new Map(deals.map((deal) => [deal.id, deal]))
  const eligibleAssignments = assignments.filter((assignment) => (
    dealById.get(assignment.dealId)?.pipelineStageId === assignment.eligibleStageId
  ))
  if (eligibleAssignments.length === 0) return []
  const eligibleDealIds = eligibleAssignments.map((assignment) => assignment.dealId)

  const [personLinks, companyLinks] = await Promise.all([
    em.find(CustomerDealPersonLink, {
      deal: { $in: eligibleDealIds },
      isPrimary: true,
    } as FilterQuery<CustomerDealPersonLink>, { populate: ['deal', 'person'] }),
    em.find(CustomerDealCompanyLink, {
      deal: { $in: eligibleDealIds },
    } as FilterQuery<CustomerDealCompanyLink>, { populate: ['deal', 'company'] }),
  ])
  const personLinkByDealId = new Map(personLinks.map((link) => [link.deal.id, link]))
  const companyLinksByDealId = new Map<string, CustomerDealCompanyLink[]>()
  for (const link of companyLinks) {
    const current = companyLinksByDealId.get(link.deal.id) ?? []
    current.push(link)
    companyLinksByDealId.set(link.deal.id, current)
  }

  const personEntityIds = [...new Set(personLinks.map((link) => link.person.id))]
  const companyEntityIds = [...new Set(companyLinks.map((link) => link.company.id))]
  const entityIds = [...personEntityIds, ...companyEntityIds]
  const entities = entityIds.length
    ? await findWithDecryption(
        em,
        CustomerEntity,
        {
          id: { $in: entityIds },
          tenantId: scope.tenantId,
          organizationId: scope.organizationId,
          deletedAt: null,
        } as FilterQuery<CustomerEntity>,
        undefined,
        scope,
      )
    : []
  const entityById = new Map(entities.map((entity) => [entity.id, entity]))

  const [personProfiles, companyProfiles] = await Promise.all([
    personEntityIds.length
      ? em.find(CustomerPersonProfile, {
          entity: { $in: personEntityIds },
          tenantId: scope.tenantId,
          organizationId: scope.organizationId,
        } as FilterQuery<CustomerPersonProfile>, { populate: ['entity'] })
      : Promise.resolve([]),
    companyEntityIds.length
      ? em.find(CustomerCompanyProfile, {
          entity: { $in: companyEntityIds },
          tenantId: scope.tenantId,
          organizationId: scope.organizationId,
        } as FilterQuery<CustomerCompanyProfile>, { populate: ['entity'] })
      : Promise.resolve([]),
  ])
  const personProfileByEntityId = new Map(personProfiles.map((profile) => [profile.entity.id, profile]))
  const companyProfileByEntityId = new Map(companyProfiles.map((profile) => [profile.entity.id, profile]))
  const personProfileIds = personProfiles.map((profile) => profile.id)
  const companyProfileIds = companyProfiles.map((profile) => profile.id)

  const [turnoverDef, arrearsDef, businessStartDef, industryDef, mobileDef] = await Promise.all([
    requireDefinition(em, { ...scope, entityId: 'customers:customer_deal', key: 'turnover', expectedKind: 'integer' }),
    requireDefinition(em, { ...scope, entityId: 'customers:customer_deal', key: 'arrears', expectedKind: 'boolean' }),
    requireDefinition(em, { ...scope, entityId: 'customers:customer_company_profile', key: 'business_start_date', expectedKind: 'date' }),
    requireDefinition(em, { ...scope, entityId: 'customers:customer_company_profile', key: 'industry', expectedKind: 'dictionary' }),
    requireDefinition(em, { ...scope, entityId: 'customers:customer_person_profile', key: 'mobile', expectedKind: 'text' }),
  ])
  const [dealValues, companyValues, personValues] = await Promise.all([
    loadCustomFieldValues({
      em,
      entityId: 'customers:customer_deal',
      recordIds: eligibleDealIds,
      tenantIdByRecord: recordScope(eligibleDealIds, scope.tenantId),
      organizationIdByRecord: recordScope(eligibleDealIds, scope.organizationId),
      tenantFallbacks: [scope.tenantId],
    }),
    loadCustomFieldValues({
      em,
      entityId: 'customers:customer_company_profile',
      recordIds: companyProfileIds,
      tenantIdByRecord: recordScope(companyProfileIds, scope.tenantId),
      organizationIdByRecord: recordScope(companyProfileIds, scope.organizationId),
      tenantFallbacks: [scope.tenantId],
    }),
    loadCustomFieldValues({
      em,
      entityId: 'customers:customer_person_profile',
      recordIds: personProfileIds,
      tenantIdByRecord: recordScope(personProfileIds, scope.tenantId),
      organizationIdByRecord: recordScope(personProfileIds, scope.organizationId),
      tenantFallbacks: [scope.tenantId],
    }),
  ])

  const dictionaryId = readDictionaryId(industryDef)
  const industryEntryIds = companyProfileIds
    .map((id) => asString(readLoadedCustomFieldValue(companyValues, id, industryDef.key)))
    .filter((id): id is string => id !== null)
  const industryEntries = industryEntryIds.length
    ? await em.find(DictionaryEntry, {
        id: { $in: industryEntryIds },
        dictionary: dictionaryId,
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
      } as FilterQuery<DictionaryEntry>)
    : []
  const industryLabelById = new Map(industryEntries.map((entry) => [entry.id, entry.label]))

  return eligibleAssignments.map((assignment) => {
    const personLink = personLinkByDealId.get(assignment.dealId)
    const companyLink = selectOldestCompanyLink(
      (companyLinksByDealId.get(assignment.dealId) ?? [])
        .filter((link) => entityById.has(link.company.id)),
    )
    const personEntity = personLink ? entityById.get(personLink.person.id) : null
    const companyEntity = companyLink ? entityById.get(companyLink.company.id) : null
    const personProfile = personEntity ? personProfileByEntityId.get(personEntity.id) : null
    const companyProfile = companyEntity ? companyProfileByEntityId.get(companyEntity.id) : null
    const industryEntryId = companyProfile
      ? asString(readLoadedCustomFieldValue(companyValues, companyProfile.id, industryDef.key))
      : null
    return {
      id: assignment.dealId,
      assignmentId: assignment.id,
      updatedAt: assignment.updatedAt.toISOString(),
      companyName: companyEntity?.displayName ?? null,
      companyPhone: companyEntity?.primaryPhone ?? null,
      personMobile: personProfile
        ? asString(readLoadedCustomFieldValue(personValues, personProfile.id, mobileDef.key))
        : null,
      personEmail: personEntity?.primaryEmail ?? null,
      turnover: asNumber(readLoadedCustomFieldValue(dealValues, assignment.dealId, turnoverDef.key)),
      businessStartDate: companyProfile
        ? asString(readLoadedCustomFieldValue(companyValues, companyProfile.id, businessStartDef.key))
        : null,
      arrears: asBoolean(readLoadedCustomFieldValue(dealValues, assignment.dealId, arrearsDef.key)),
      industry: industryEntryId ? industryLabelById.get(industryEntryId) ?? null : null,
      partnerStatus: assignment.partnerStatus,
    }
  })
}

export async function loadPortalActivities(
  em: EntityManager,
  input: {
    personEntityId: string | null
    tenantId: string
    organizationId: string
    pageSize: number
    cursor?: { timestamp: string | null; id: string } | null
  },
): Promise<{ items: PortalActivityProjection[]; nextCursor: { timestamp: string | null; id: string } | null }> {
  if (!input.personEntityId) return { items: [], nextCursor: null }
  const interactions = await em.find(CustomerInteraction, portalActivityWhere({
    personEntityId: input.personEntityId,
    tenantId: input.tenantId,
    organizationId: input.organizationId,
    cursor: input.cursor,
  }), {
    orderBy: { occurredAt: QueryOrder.DESC_NULLS_LAST, id: QueryOrder.DESC },
    limit: input.pageSize + 1,
  })
  const page = interactions.slice(0, input.pageSize)
  const items = page.map((interaction) => ({
    id: interaction.id,
    type: interaction.interactionType,
    occurredAt: interaction.occurredAt?.toISOString() ?? null,
    direction: null,
    summary: sanitizeActivitySummary(interaction.title),
  }))
  const last = interactions.length > input.pageSize ? page.at(-1) : null
  return {
    items,
    nextCursor: last ? { timestamp: last.occurredAt?.toISOString() ?? null, id: last.id } : null,
  }
}

export function portalActivityWhere(input: {
  personEntityId: string
  tenantId: string
  organizationId: string
  cursor?: { timestamp: string | null; id: string } | null
}): FilterQuery<CustomerInteraction> {
  return {
    entity: input.personEntityId,
    tenantId: input.tenantId,
    organizationId: input.organizationId,
    interactionType: { $ne: 'email' },
    visibility: 'public',
    $or: [{ source: null }, { source: { $ne: 'internal' } }],
    ...(input.cursor?.timestamp ? {
      $and: [{
        $or: [
          { occurredAt: { $lt: new Date(input.cursor.timestamp) } },
          { occurredAt: new Date(input.cursor.timestamp), id: { $lt: input.cursor.id } },
          { occurredAt: null },
        ],
      }],
    } : input.cursor ? { occurredAt: null, id: { $lt: input.cursor.id } } : {}),
    deletedAt: null,
  } as FilterQuery<CustomerInteraction>
}

export async function loadPrimaryPersonEntityId(
  em: EntityManager,
  input: { dealId: string; tenantId: string; organizationId: string },
): Promise<string | null> {
  const link = await em.findOne(CustomerDealPersonLink, {
    deal: {
      id: input.dealId,
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      deletedAt: null,
    },
    isPrimary: true,
  } as FilterQuery<CustomerDealPersonLink>, { populate: ['person'] })
  return link?.person.id ?? null
}
