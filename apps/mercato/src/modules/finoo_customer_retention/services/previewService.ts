import type { EntityManager } from '@mikro-orm/postgresql'
import type { AwilixContainer } from 'awilix'
import { sql } from 'kysely'
import {
  CustomerActivity,
  CustomerComment,
  CustomerEntity,
  CustomerInteraction,
} from '@open-mercato/core/modules/customers/data/entities'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { BasicQueryEngine } from '@open-mercato/shared/lib/query/engine'
import { SortDir, type QueryEngine } from '@open-mercato/shared/lib/query/types'
import {
  getEnabledModuleIds,
  hasEnabledModulesRegistry,
} from '@open-mercato/shared/security/enabledModulesRegistry'
import { FinooCustomerRetentionState } from '../data/entities'
import { FINOO_CUSTOMER_RETENTION_BATCH_SIZE } from '../lib/constants'
import { calculateRetentionProjection, latestTrustedActivity } from './projection'

export type RetentionPreviewScope = {
  tenantId: string
  organizationId: string
}

export type RetentionPreviewCounts = {
  totalEligible: number
  newlyExpired: number
  alreadyExpired: number
}

type PartnerFacts = {
  activeCustomerUserIds: string[]
  latestDeletedAtByCustomerUserId: Map<string, Date>
}

type PartnerProvider = {
  findFacts(input: RetentionPreviewScope & {
    customerUserIds: string[]
    em: EntityManager
  }): Promise<PartnerFacts>
}

type CustomerUserProjection = {
  id?: unknown
  person_entity_id?: unknown
  personEntityId?: unknown
}

type ActivityFact = { createdAt: Date; occurredAt?: Date | null }

function isCompletedStatus(status: string): boolean {
  return status === 'done' || status === 'completed'
}

function asDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isFinite(date.getTime()) ? date : null
}

function entityId(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (typeof value !== 'object' || value === null || !('id' in value)) return null
  return typeof value.id === 'string' ? value.id : null
}

function maxDate(left: Date | null, right: Date | null): Date | null {
  if (!left) return right
  if (!right) return left
  return left > right ? left : right
}

function clampToNow(value: Date, now: Date): Date {
  return value > now ? now : value
}

function pushFact(
  factsByEntityId: Map<string, ActivityFact[]>,
  entityId: string,
  fact: ActivityFact,
): void {
  const current = factsByEntityId.get(entityId) ?? []
  current.push(fact)
  factsByEntityId.set(entityId, current)
}

function resolvePartnerProvider(
  container: AwilixContainer,
  moduleId: string,
  registrationName: string,
): PartnerProvider | null {
  if (!hasEnabledModulesRegistry()) {
    throw new Error('[internal] Enabled-module registry is unavailable during retention preview')
  }
  if (!getEnabledModuleIds().includes(moduleId)) return null
  if (!container.hasRegistration(registrationName)) {
    throw new Error(`[internal] Enabled ${moduleId} module is missing its retention provider`)
  }
  return container.resolve<PartnerProvider>(registrationName)
}

async function databaseNow(em: EntityManager): Promise<Date> {
  const row = await em.getKysely()
    .selectNoFrom(sql<Date | string>`current_timestamp`.as('now'))
    .executeTakeFirstOrThrow()
  const value = row.now
  return value instanceof Date ? value : new Date(String(value))
}

async function loadCustomerUsers(
  em: EntityManager,
  queryEngineFactory: (em: EntityManager) => QueryEngine,
  scope: RetentionPreviewScope,
  personIds: string[],
): Promise<CustomerUserProjection[]> {
  const queryEngine = queryEngineFactory(em)
  const pageSize = 100
  const items: CustomerUserProjection[] = []
  let page = 1
  let total = 0
  do {
    const result = await queryEngine.query<CustomerUserProjection>('customer_accounts:customer_user', {
      ...scope,
      filters: [{ field: 'person_entity_id', op: 'in', value: personIds }],
      fields: ['id', 'person_entity_id'],
      sort: [{ field: 'id', dir: SortDir.Asc }],
      page: { page, pageSize },
      withDeleted: true,
    })
    items.push(...result.items)
    total = result.total
    page += 1
  } while (items.length < total)
  return items
}

export type FinooCustomerRetentionPreviewService = ReturnType<
  typeof createFinooCustomerRetentionPreviewService
>

export function createFinooCustomerRetentionPreviewService(input: {
  em: EntityManager
  container: AwilixContainer
  queryEngineFactory?: (em: EntityManager) => QueryEngine
}) {
  const queryEngineFactory = input.queryEngineFactory ?? ((em: EntityManager) => new BasicQueryEngine(em))
  async function calculate(inputRequest: RetentionPreviewScope & {
    inactivityWindowDays: number
    currentInactivityWindowDays: number | null
    em?: EntityManager
    now?: Date
  }): Promise<RetentionPreviewCounts> {
    const em = inputRequest.em ?? input.em
    const scope = {
      tenantId: inputRequest.tenantId,
      organizationId: inputRequest.organizationId,
    }
    const now = inputRequest.now ?? await databaseNow(em)
    const providers = [
      resolvePartnerProvider(input.container, 'finoo_affiliates', 'finooAffiliateRetentionEligibilityProvider'),
      resolvePartnerProvider(input.container, 'finoo_intermediaries', 'finooIntermediaryRetentionEligibilityProvider'),
    ].filter((provider): provider is PartnerProvider => provider !== null)
    let afterCustomerEntityId: string | undefined
    const counts: RetentionPreviewCounts = {
      totalEligible: 0,
      newlyExpired: 0,
      alreadyExpired: 0,
    }

    do {
      const people = await findWithDecryption(
        em,
        CustomerEntity,
        {
          ...scope,
          kind: 'person',
          deletedAt: null,
          ...(afterCustomerEntityId ? { id: { $gt: afterCustomerEntityId } } : {}),
        },
        {
          fields: ['id', 'createdAt', 'updatedAt'],
          orderBy: { id: 'ASC' },
          limit: FINOO_CUSTOMER_RETENTION_BATCH_SIZE,
        },
        scope,
      )
      if (people.length === 0) break
      const personIds = people.map((person) => person.id)
      const [states, comments, interactions, legacyActivities, customerUsers] = await Promise.all([
        em.find(FinooCustomerRetentionState, {
          ...scope,
          customerEntityId: { $in: personIds },
        }),
        findWithDecryption(
          em,
          CustomerComment,
          { ...scope, entity: { $in: personIds }, deletedAt: null },
          { fields: ['entity', 'createdAt'] },
          scope,
        ),
        findWithDecryption(
          em,
          CustomerInteraction,
          { ...scope, entity: { $in: personIds }, deletedAt: null },
          { fields: ['entity', 'status', 'createdAt', 'occurredAt'] },
          scope,
        ),
        findWithDecryption(
          em,
          CustomerActivity,
          { ...scope, entity: { $in: personIds } },
          { fields: ['entity', 'createdAt', 'occurredAt'] },
          scope,
        ),
        loadCustomerUsers(em, queryEngineFactory, scope, personIds),
      ])
      const stateByPersonId = new Map<string, FinooCustomerRetentionState>()
      for (const state of states) {
        const current = stateByPersonId.get(state.customerEntityId)
        if (!current || state.updatedAt > current.updatedAt) {
          stateByPersonId.set(state.customerEntityId, state)
        }
      }
      const activityFactsByPersonId = new Map<string, ActivityFact[]>()
      for (const comment of comments) {
        const personId = entityId(comment.entity)
        if (personId) pushFact(activityFactsByPersonId, personId, { createdAt: comment.createdAt })
      }
      for (const interaction of interactions) {
        const personId = entityId(interaction.entity)
        if (
          personId
          && interaction.status !== 'canceled'
          && interaction.status !== 'cancelled'
        ) {
          pushFact(activityFactsByPersonId, personId, {
            createdAt: interaction.createdAt,
            occurredAt: isCompletedStatus(interaction.status) ? interaction.occurredAt : null,
          })
        }
      }
      for (const activity of legacyActivities) {
        const personId = entityId(activity.entity)
        if (personId) {
          pushFact(activityFactsByPersonId, personId, {
            createdAt: activity.createdAt,
            occurredAt: activity.occurredAt,
          })
        }
      }

      const userIdsByPersonId = new Map<string, string[]>()
      for (const customerUser of customerUsers) {
        const userId = typeof customerUser.id === 'string' ? customerUser.id : null
        const personId = typeof customerUser.person_entity_id === 'string'
          ? customerUser.person_entity_id
          : typeof customerUser.personEntityId === 'string'
            ? customerUser.personEntityId
            : null
        if (!userId || !personId) continue
        const current = userIdsByPersonId.get(personId) ?? []
        current.push(userId)
        userIdsByPersonId.set(personId, current)
      }
      const allCustomerUserIds = [...userIdsByPersonId.values()].flat()
      const providerFacts = await Promise.all(providers.map((provider) => provider.findFacts({
        ...scope,
        customerUserIds: allCustomerUserIds,
        em,
      })))
      const activeCustomerUserIds = new Set(providerFacts.flatMap((facts) => facts.activeCustomerUserIds))
      const latestDeletedAtByCustomerUserId = new Map<string, Date>()
      for (const facts of providerFacts) {
        for (const [userId, deletedAt] of facts.latestDeletedAtByCustomerUserId) {
          latestDeletedAtByCustomerUserId.set(
            userId,
            maxDate(latestDeletedAtByCustomerUserId.get(userId) ?? null, deletedAt)!,
          )
        }
      }

      for (const person of people) {
        const state = stateByPersonId.get(person.id)
        const customerUserIds = userIdsByPersonId.get(person.id) ?? []
        const excluded = customerUserIds.some((id) => activeCustomerUserIds.has(id))
        if (excluded) continue
        counts.totalEligible += 1
        const latestPartnerDeletedAt = customerUserIds.reduce<Date | null>(
          (latest, id) => maxDate(latest, latestDeletedAtByCustomerUserId.get(id) ?? null),
          null,
        )
        const restoredEligibility = state?.deletedAt != null
        const previousStatus = restoredEligibility ? null : state?.retentionStatus ?? null
        const previousEligibilityAnchor = state?.eligibilityAnchorAt ?? person.createdAt
        const partnerReentryAt = latestPartnerDeletedAt && latestPartnerDeletedAt > previousEligibilityAnchor
          ? clampToNow(latestPartnerDeletedAt, now)
          : null
        const reenteredEligibility = !restoredEligibility && (
          previousStatus === 'excluded' || partnerReentryAt !== null
        )
        const eligibilityAnchorAt = restoredEligibility
          ? clampToNow(asDate(person.updatedAt) ?? now, now)
          : reenteredEligibility
          ? partnerReentryAt ?? asDate(person.updatedAt) ?? now
          : previousEligibilityAnchor
        const latestQualifyingActivityAt = latestTrustedActivity(
          activityFactsByPersonId.get(person.id) ?? [],
          now,
          eligibilityAnchorAt,
        )
        const currentProjection = calculateRetentionProjection({
          now,
          inactivityWindowDays: inputRequest.currentInactivityWindowDays,
          eligibilityAnchorAt,
          latestQualifyingActivityAt,
          previousStatus,
          previousExpiredAt: state?.expiredAt ?? null,
          previousRetentionExpiresAt: state?.retentionExpiresAt ?? null,
          reenteredEligibility,
          excluded: false,
        })
        const proposedProjection = calculateRetentionProjection({
          now,
          inactivityWindowDays: inputRequest.inactivityWindowDays,
          eligibilityAnchorAt: currentProjection.eligibilityAnchorAt,
          latestQualifyingActivityAt: currentProjection.lastQualifyingActivityAt,
          previousStatus: currentProjection.retentionStatus,
          previousExpiredAt: currentProjection.expiredAt,
          previousRetentionExpiresAt: currentProjection.retentionExpiresAt,
          reenteredEligibility: false,
          excluded: false,
        })
        if (currentProjection.retentionStatus === 'expired') counts.alreadyExpired += 1
        else if (proposedProjection.retentionStatus === 'expired') counts.newlyExpired += 1
      }

      afterCustomerEntityId = people.length === FINOO_CUSTOMER_RETENTION_BATCH_SIZE
        ? people.at(-1)?.id
        : undefined
    } while (afterCustomerEntityId)

    return counts
  }

  return { calculate, databaseNow: (em: EntityManager = input.em) => databaseNow(em) }
}
