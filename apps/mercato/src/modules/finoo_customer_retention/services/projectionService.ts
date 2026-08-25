import { LockMode } from '@mikro-orm/core'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { AwilixContainer } from 'awilix'
import { sql } from 'kysely'
import {
  CustomerActivity,
  CustomerComment,
  CustomerEntity,
  CustomerInteraction,
  CustomerPersonProfile,
} from '@open-mercato/core/modules/customers/data/entities'
import { ActionLog } from '@open-mercato/core/modules/audit_logs/data/entities'
import { loadCustomFieldValues } from '@open-mercato/shared/lib/crud/custom-fields'
import { DefaultDataEngine } from '@open-mercato/shared/lib/data/engine'
import { findOneWithDecryption, findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { BasicQueryEngine } from '@open-mercato/shared/lib/query/engine'
import { SortDir, type QueryEngine } from '@open-mercato/shared/lib/query/types'
import {
  getEnabledModuleIds,
  hasEnabledModulesRegistry,
} from '@open-mercato/shared/security/enabledModulesRegistry'
import {
  FinooCustomerRetentionSettings,
  FinooCustomerRetentionState,
  type FinooCustomerRetentionStatus,
} from '../data/entities'
import {
  FINOO_CUSTOMER_RETENTION_BATCH_SIZE,
  FINOO_CUSTOMER_RETENTION_PERSON_ENTITY_ID,
  FINOO_RETENTION_EXPIRES_AT_FIELD,
  FINOO_RETENTION_STATUS_FIELD,
} from '../lib/constants'
import {
  calculateRetentionProjection,
  latestTrustedActivity,
  type RetentionActivityFact,
} from './projection'
import { lockRetentionSubject } from './retentionLock'

const logger = createLogger('finoo_customer_retention').child({ component: 'projection-service' })

export type FinooRetentionScope = {
  tenantId: string
  organizationId: string
}

export type ReconcilePersonInput = FinooRetentionScope & {
  customerEntityId: string
  reconciliationGeneration?: number
}

export type ReconcilePersonResult = {
  status: FinooCustomerRetentionStatus | 'missing'
  changed: boolean
  mirrorChanged: boolean
  staleGeneration: boolean
}

export type AuthoritativeIdentityErasureResult = ReconcilePersonResult & {
  operationApplied: boolean
}

export type ReconciliationPage = {
  selected: number
  processed: number
  changed: number
  nextCustomerEntityId: string | null
  reconciliationGeneration: number
  staleGeneration: boolean
}

type PartnerFacts = {
  activeCustomerUserIds: string[]
  latestDeletedAtByCustomerUserId: Map<string, Date>
}

type PartnerProvider = {
  findFacts(input: FinooRetentionScope & {
    customerUserIds: string[]
    em: EntityManager
  }): Promise<PartnerFacts>
}

type EventBus = {
  emitEvent(event: string, payload: unknown, options?: unknown): Promise<void>
}

type CustomerUserProjection = {
  id?: unknown
  person_entity_id?: unknown
  personEntityId?: unknown
}

function sameDate(left: Date | null | undefined, right: Date | null | undefined): boolean {
  return (left?.getTime() ?? null) === (right?.getTime() ?? null)
}

function maxDate(values: Iterable<Date>): Date | null {
  let latest: Date | null = null
  for (const value of values) {
    if (!latest || value > latest) latest = value
  }
  return latest
}

function clampToNow(value: Date, now: Date): Date {
  return value > now ? now : value
}

function stateChanged(
  state: FinooCustomerRetentionState,
  projection: {
    retentionStatus: FinooCustomerRetentionStatus
    eligibilityAnchorAt: Date
    lastQualifyingActivityAt: Date | null
    retentionExpiresAt: Date | null
    expiredAt: Date | null
  },
): boolean {
  return state.retentionStatus !== projection.retentionStatus
    || !sameDate(state.eligibilityAnchorAt, projection.eligibilityAnchorAt)
    || !sameDate(state.lastQualifyingActivityAt, projection.lastQualifyingActivityAt)
    || !sameDate(state.retentionExpiresAt, projection.retentionExpiresAt)
    || !sameDate(state.expiredAt, projection.expiredAt)
    || state.deletedAt !== null && state.deletedAt !== undefined
}

function isCanceledInteraction(interaction: CustomerInteraction): boolean {
  return interaction.status === 'canceled' || interaction.status === 'cancelled'
}

function isCompletedInteraction(interaction: CustomerInteraction): boolean {
  return interaction.status === 'done' || interaction.status === 'completed'
}

async function databaseNow(em: EntityManager): Promise<Date> {
  const row = await em.getKysely()
    .selectNoFrom(sql<Date | string>`current_timestamp`.as('now'))
    .executeTakeFirstOrThrow()
  const value = row.now
  return value instanceof Date ? value : new Date(String(value))
}

async function loadCustomerUserIds(
  em: EntityManager,
  queryEngineFactory: (em: EntityManager) => QueryEngine,
  scope: FinooRetentionScope,
  customerEntityId: string,
): Promise<string[]> {
  const queryEngine = queryEngineFactory(em)
  const pageSize = 100
  const ids: string[] = []
  let page = 1
  let total = 0
  do {
    const result = await queryEngine.query<CustomerUserProjection>('customer_accounts:customer_user', {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      filters: [{ field: 'person_entity_id', op: 'eq', value: customerEntityId }],
      fields: ['id', 'person_entity_id'],
      sort: [{ field: 'id', dir: SortDir.Asc }],
      page: { page, pageSize },
      withDeleted: true,
    })
    ids.push(...result.items
      .map((item) => item.id)
      .filter((id): id is string => typeof id === 'string'))
    total = result.total
    page += 1
  } while (ids.length < total)
  return ids
}

function resolvePartnerProvider(
  container: AwilixContainer,
  moduleId: string,
  registrationName: string,
): PartnerProvider | null {
  if (!hasEnabledModulesRegistry()) {
    throw new Error('[internal] Enabled-module registry is unavailable during retention evaluation')
  }
  const enabled = getEnabledModuleIds().includes(moduleId)
  if (!enabled) return null
  if (!container.hasRegistration(registrationName)) {
    throw new Error(`[internal] Enabled ${moduleId} module is missing its retention provider`)
  }
  return container.resolve<PartnerProvider>(registrationName)
}

async function loadPartnerFacts(
  em: EntityManager,
  container: AwilixContainer,
  scope: FinooRetentionScope,
  customerUserIds: string[],
): Promise<{ excluded: boolean; latestDeletedAt: Date | null }> {
  const providers = [
    resolvePartnerProvider(
      container,
      'finoo_affiliates',
      'finooAffiliateRetentionEligibilityProvider',
    ),
    resolvePartnerProvider(
      container,
      'finoo_intermediaries',
      'finooIntermediaryRetentionEligibilityProvider',
    ),
  ].filter((provider): provider is PartnerProvider => provider !== null)

  const facts = await Promise.all(providers.map((provider) => provider.findFacts({
    ...scope,
    customerUserIds,
    em,
  })))
  const activeIds = new Set(facts.flatMap((fact) => fact.activeCustomerUserIds))
  const deletedDates = facts.flatMap((fact) => [...fact.latestDeletedAtByCustomerUserId.values()])
  return {
    excluded: customerUserIds.some((id) => activeIds.has(id)),
    latestDeletedAt: maxDate(deletedDates),
  }
}

async function loadActivityFacts(
  em: EntityManager,
  scope: FinooRetentionScope,
  customerEntityId: string,
): Promise<RetentionActivityFact[]> {
  const [comments, interactions, legacyActivities] = await Promise.all([
    findWithDecryption(
      em,
      CustomerComment,
      { ...scope, entity: customerEntityId, deletedAt: null },
      { fields: ['createdAt'] },
      scope,
    ),
    findWithDecryption(
      em,
      CustomerInteraction,
      { ...scope, entity: customerEntityId, deletedAt: null },
      { fields: ['status', 'createdAt', 'occurredAt'] },
      scope,
    ),
    findWithDecryption(
      em,
      CustomerActivity,
      { ...scope, entity: customerEntityId },
      { fields: ['createdAt', 'occurredAt'] },
      scope,
    ),
  ])
  return [
    ...comments.map((comment) => ({ createdAt: comment.createdAt })),
    ...interactions
      .filter((interaction) => !isCanceledInteraction(interaction))
      .map((interaction) => ({
        createdAt: interaction.createdAt,
        occurredAt: isCompletedInteraction(interaction) ? interaction.occurredAt : null,
      })),
    ...legacyActivities.map((activity) => ({
      createdAt: activity.createdAt,
      occurredAt: activity.occurredAt,
    })),
  ]
}

async function emitPersonIndexUpsert(
  container: AwilixContainer,
  scope: FinooRetentionScope,
  profileId: string,
  customerEntityId: string,
): Promise<void> {
  if (!container.hasRegistration('eventBus')) return
  const eventBus = container.resolve<EventBus>('eventBus')
  await eventBus.emitEvent('query_index.upsert_one', {
    entityType: FINOO_CUSTOMER_RETENTION_PERSON_ENTITY_ID,
    recordId: profileId,
    ...scope,
  }, { rethrowHandlerErrors: true })
  await eventBus.emitEvent('query_index.upsert_one', {
    entityType: 'customers:customer_entity',
    recordId: customerEntityId,
    ...scope,
  }, { rethrowHandlerErrors: true })
}

export async function runPersonReindexPostCommit(input: {
  container: AwilixContainer
  scope: FinooRetentionScope
  profileId: string
  customerEntityId: string
  operationApplied: boolean
}): Promise<void> {
  try {
    await emitPersonIndexUpsert(
      input.container,
      input.scope,
      input.profileId,
      input.customerEntityId,
    )
  } catch (error) {
    if (!input.operationApplied) throw error
    logger.error('FINOO retention post-erasure reindex failed', {
      error,
      tenantId: input.scope.tenantId,
      organizationId: input.scope.organizationId,
    })
  }
}

async function loadLatestDeleteUndoAt(
  em: EntityManager,
  scope: FinooRetentionScope,
  customerEntityId: string,
  after: Date,
): Promise<Date | null> {
  const action = await em.findOne(ActionLog, {
    ...scope,
    commandId: 'customers.people.delete',
    resourceKind: 'customers.person',
    resourceId: customerEntityId,
    executionState: 'undone',
    updatedAt: { $gt: after },
    deletedAt: null,
  }, {
    fields: ['updatedAt'],
    orderBy: { updatedAt: 'DESC' },
  })
  return action?.updatedAt ?? null
}

export type FinooCustomerRetentionProjectionService = ReturnType<
  typeof createFinooCustomerRetentionProjectionService
>

export function createFinooCustomerRetentionProjectionService(input: {
  em: EntityManager
  container: AwilixContainer
  queryEngineFactory?: (em: EntityManager) => QueryEngine
}) {
  const queryEngineFactory = input.queryEngineFactory ?? ((em: EntityManager) => new BasicQueryEngine(em))
  async function reconcilePersonWithAuthoritativeOperation(
    request: ReconcilePersonInput,
    dueOperation?: () => Promise<void>,
  ): Promise<AuthoritativeIdentityErasureResult> {
    const scope = {
      tenantId: request.tenantId,
      organizationId: request.organizationId,
    }
    let profileToReindex: string | null = null
    let operationApplied = false
    const result = await input.em.fork().transactional(async (em) => {
      await lockRetentionSubject(em, scope, request.customerEntityId)
      const person = await findOneWithDecryption(
        em,
        CustomerEntity,
        { id: request.customerEntityId, ...scope },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
        scope,
      )
      if (!person || person.deletedAt || person.kind !== 'person') {
        const missing = await excludeMissingPersonInTransaction(
          em,
          input.container,
          scope,
          request.customerEntityId,
        )
        profileToReindex = missing.profileToReindex
        return missing.result
      }

      const settings = await em.findOne(FinooCustomerRetentionSettings, scope)
      if (!settings) throw new Error('[internal] Finoo retention settings are missing')
      if (
        request.reconciliationGeneration !== undefined
        && request.reconciliationGeneration !== settings.reconciliationGeneration
      ) {
        return {
          status: 'missing' as const,
          changed: false,
          mirrorChanged: false,
          staleGeneration: true,
        }
      }

      const profile = await em.findOne(CustomerPersonProfile, {
        ...scope,
        entity: person.id,
      })
      if (!profile) {
        const missing = await excludeMissingPersonInTransaction(
          em,
          input.container,
          scope,
          person.id,
        )
        profileToReindex = missing.profileToReindex
        return missing.result
      }

      let state = await em.findOne(
        FinooCustomerRetentionState,
        { ...scope, customerEntityId: person.id },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      )
      const restoredEligibility = state?.deletedAt != null
      const previousStatus = restoredEligibility ? null : state?.retentionStatus ?? null
      const customerUserIds = await loadCustomerUserIds(em, queryEngineFactory, scope, person.id)
      const partnerFacts = await loadPartnerFacts(em, input.container, scope, customerUserIds)
      const now = await databaseNow(em)
      const previousEligibilityAnchor = state?.eligibilityAnchorAt ?? person.createdAt
      const deleteUndoAt = await loadLatestDeleteUndoAt(
        em,
        scope,
        person.id,
        previousEligibilityAnchor,
      )
      const partnerReentryAt = !partnerFacts.excluded
        && partnerFacts.latestDeletedAt
        && partnerFacts.latestDeletedAt > previousEligibilityAnchor
        ? clampToNow(partnerFacts.latestDeletedAt, now)
        : null
      const lifecycleReentryAt = deleteUndoAt ? clampToNow(deleteUndoAt, now) : null
      const reenteredEligibility = !restoredEligibility && !partnerFacts.excluded && (
        previousStatus === 'excluded'
        || partnerReentryAt !== null
        || lifecycleReentryAt !== null
      )
      const eligibilityAnchorAt = restoredEligibility
        ? clampToNow(person.updatedAt ?? now, now)
        : reenteredEligibility
        ? maxDate([partnerReentryAt, lifecycleReentryAt].filter((value): value is Date => value !== null))
          ?? person.updatedAt
          ?? now
        : previousEligibilityAnchor
      const activityFacts = partnerFacts.excluded
        ? []
        : await loadActivityFacts(em, scope, person.id)
      const latestActivity = partnerFacts.excluded
        ? null
        : latestTrustedActivity(activityFacts, now, eligibilityAnchorAt)
      const projection = calculateRetentionProjection({
        now,
        inactivityWindowDays: settings.inactivityWindowDays ?? null,
        eligibilityAnchorAt,
        latestQualifyingActivityAt: latestActivity,
        previousStatus,
        previousExpiredAt: state?.expiredAt ?? null,
        previousRetentionExpiresAt: state?.retentionExpiresAt ?? null,
        reenteredEligibility,
        excluded: partnerFacts.excluded,
      })

      const isNewState = !state
      if (!state) {
        state = em.create(FinooCustomerRetentionState, {
          ...scope,
          customerEntityId: person.id,
          ...projection,
          lastEvaluatedAt: now,
          deletedAt: null,
        })
        em.persist(state)
      }
      const changed = isNewState || stateChanged(state, projection)
      state.retentionStatus = projection.retentionStatus
      state.eligibilityAnchorAt = projection.eligibilityAnchorAt
      state.lastQualifyingActivityAt = projection.lastQualifyingActivityAt
      state.retentionExpiresAt = projection.retentionExpiresAt
      state.expiredAt = projection.expiredAt
      state.lastEvaluatedAt = now
      state.deletedAt = null
      if (projection.retentionStatus !== 'expired') state.identityErasedAt = null

      const existingMirrors = await loadCustomFieldValues({
        em,
        entityId: FINOO_CUSTOMER_RETENTION_PERSON_ENTITY_ID,
        recordIds: [profile.id],
        tenantIdByRecord: { [profile.id]: scope.tenantId },
        organizationIdByRecord: { [profile.id]: scope.organizationId },
      })
      const existing = existingMirrors[profile.id] ?? {}
      const nextStatus = projection.retentionStatus === 'excluded'
        ? null
        : projection.retentionStatus
      const nextExpiry = projection.retentionStatus === 'excluded'
        ? null
        : projection.retentionExpiresAt?.toISOString() ?? null
      const existingExpiry = existing[FINOO_RETENTION_EXPIRES_AT_FIELD]
      const normalizedExistingExpiry = existingExpiry instanceof Date
        ? existingExpiry.toISOString()
        : existingExpiry ?? null
      const mirrorChanged = existing[FINOO_RETENTION_STATUS_FIELD] !== nextStatus
        || normalizedExistingExpiry !== nextExpiry

      if (mirrorChanged) {
        const dataEngine = new DefaultDataEngine(em, input.container)
        await dataEngine.setCustomFields({
          entityId: FINOO_CUSTOMER_RETENTION_PERSON_ENTITY_ID,
          recordId: profile.id,
          ...scope,
          values: {
            [FINOO_RETENTION_STATUS_FIELD]: nextStatus,
            [FINOO_RETENTION_EXPIRES_AT_FIELD]: nextExpiry,
          },
          notify: false,
        })
        profileToReindex = profile.id
      }
      if (
        dueOperation
        && projection.retentionStatus === 'expired'
        && projection.retentionExpiresAt !== null
        && projection.retentionExpiresAt <= now
        && !state.identityErasedAt
      ) {
        await dueOperation()
        state.identityErasedAt = now
        operationApplied = true
      }
      await em.flush()
      return {
        status: projection.retentionStatus,
        changed,
        mirrorChanged,
        staleGeneration: false,
      }
    })

    if (profileToReindex) {
      await runPersonReindexPostCommit({
        container: input.container,
        scope,
        profileId: profileToReindex,
        customerEntityId: request.customerEntityId,
        operationApplied,
      })
    }
    return { ...result, operationApplied }
  }

  async function reconcilePerson(request: ReconcilePersonInput): Promise<ReconcilePersonResult> {
    const { operationApplied: _operationApplied, ...result } = await reconcilePersonWithAuthoritativeOperation(request)
    return result
  }

  async function runIdentityErasureIfAuthoritativelyDue(
    request: ReconcilePersonInput,
    operation: () => Promise<void>,
  ): Promise<AuthoritativeIdentityErasureResult> {
    return reconcilePersonWithAuthoritativeOperation(request, operation)
  }

  async function excludeMissingPerson(
    request: FinooRetentionScope & { customerEntityId: string },
  ): Promise<ReconcilePersonResult> {
    const scope = { tenantId: request.tenantId, organizationId: request.organizationId }
    let profileToReindex: string | null = null
    const result = await input.em.fork().transactional(async (em) => {
      await lockRetentionSubject(em, scope, request.customerEntityId)
      const missing = await excludeMissingPersonInTransaction(
        em,
        input.container,
        scope,
        request.customerEntityId,
      )
      profileToReindex = missing.profileToReindex
      return missing.result
    })
    if (profileToReindex) {
      await emitPersonIndexUpsert(
        input.container,
        scope,
        profileToReindex,
        request.customerEntityId,
      )
    }
    return result
  }

  async function reconcilePage(request: FinooRetentionScope & {
    afterCustomerEntityId?: string
    reconciliationGeneration?: number
  }): Promise<ReconciliationPage> {
    const scope = { tenantId: request.tenantId, organizationId: request.organizationId }
    const settings = await input.em.findOne(FinooCustomerRetentionSettings, scope)
    if (!settings) throw new Error('[internal] Finoo retention settings are missing')
    if (
      request.reconciliationGeneration !== undefined
      && request.reconciliationGeneration !== settings.reconciliationGeneration
    ) {
      return {
        selected: 0,
        processed: 0,
        changed: 0,
        nextCustomerEntityId: null,
        reconciliationGeneration: settings.reconciliationGeneration,
        staleGeneration: true,
      }
    }
    const generation = settings.reconciliationGeneration
    const cursorFilter = request.afterCustomerEntityId
      ? { $gt: request.afterCustomerEntityId }
      : undefined
    const [people, projectedStates] = await Promise.all([
      findWithDecryption(
        input.em,
        CustomerEntity,
        {
          ...scope,
          kind: 'person',
          deletedAt: null,
          ...(cursorFilter ? { id: cursorFilter } : {}),
        },
        {
          fields: ['id'],
          orderBy: { id: 'ASC' },
          limit: FINOO_CUSTOMER_RETENTION_BATCH_SIZE,
        },
        scope,
      ),
      input.em.find(
        FinooCustomerRetentionState,
        {
          ...scope,
          deletedAt: null,
          ...(cursorFilter ? { customerEntityId: cursorFilter } : {}),
        },
        {
          fields: ['customerEntityId'],
          orderBy: { customerEntityId: 'ASC' },
          limit: FINOO_CUSTOMER_RETENTION_BATCH_SIZE,
        },
      ),
    ])
    const customerEntityIds = [...new Set([
      ...people.map((person) => person.id),
      ...projectedStates.map((state) => state.customerEntityId),
    ])]
      .sort((left, right) => left.localeCompare(right))
      .slice(0, FINOO_CUSTOMER_RETENTION_BATCH_SIZE)
    let changed = 0
    let processed = 0
    for (const customerEntityId of customerEntityIds) {
      const result = await reconcilePerson({
        ...scope,
        customerEntityId,
        reconciliationGeneration: generation,
      })
      if (result.staleGeneration) {
        return {
          selected: customerEntityIds.length,
          processed,
          changed,
          nextCustomerEntityId: null,
          reconciliationGeneration: generation,
          staleGeneration: true,
        }
      }
      processed += 1
      if (result.changed || result.mirrorChanged) changed += 1
    }
    return {
      selected: customerEntityIds.length,
      processed,
      changed,
      nextCustomerEntityId: customerEntityIds.length === FINOO_CUSTOMER_RETENTION_BATCH_SIZE
        ? customerEntityIds.at(-1) ?? null
        : null,
      reconciliationGeneration: generation,
      staleGeneration: false,
    }
  }

  return {
    reconcilePerson,
    runIdentityErasureIfAuthoritativelyDue,
    excludeMissingPerson,
    reconcilePage,
  }
}

async function excludeMissingPersonInTransaction(
  em: EntityManager,
  container: AwilixContainer,
  scope: FinooRetentionScope,
  customerEntityId: string,
): Promise<{ result: ReconcilePersonResult; profileToReindex: string | null }> {
  const now = await databaseNow(em)
  const state = await em.findOne(
    FinooCustomerRetentionState,
    { ...scope, customerEntityId },
    { lockMode: LockMode.PESSIMISTIC_WRITE },
  )
  const profile = await em.findOne(CustomerPersonProfile, {
    ...scope,
    entity: customerEntityId,
  })
  let mirrorChanged = false
  if (profile) {
    const existingMirrors = await loadCustomFieldValues({
      em,
      entityId: FINOO_CUSTOMER_RETENTION_PERSON_ENTITY_ID,
      recordIds: [profile.id],
      tenantIdByRecord: { [profile.id]: scope.tenantId },
      organizationIdByRecord: { [profile.id]: scope.organizationId },
    })
    const existing = existingMirrors[profile.id] ?? {}
    mirrorChanged = existing[FINOO_RETENTION_STATUS_FIELD] != null
      || existing[FINOO_RETENTION_EXPIRES_AT_FIELD] != null
    if (mirrorChanged) {
      const dataEngine = new DefaultDataEngine(em, container)
      await dataEngine.setCustomFields({
        entityId: FINOO_CUSTOMER_RETENTION_PERSON_ENTITY_ID,
        recordId: profile.id,
        ...scope,
        values: {
          [FINOO_RETENTION_STATUS_FIELD]: null,
          [FINOO_RETENTION_EXPIRES_AT_FIELD]: null,
        },
        notify: false,
      })
    }
  }

  const changed = state ? state.deletedAt == null : false
  if (state) {
    state.deletedAt = now
    state.lastEvaluatedAt = now
  }
  await em.flush()
  return {
    result: {
      status: 'missing',
      changed,
      mirrorChanged,
      staleGeneration: false,
    },
    profileToReindex: mirrorChanged && profile ? profile.id : null,
  }
}
