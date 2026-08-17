import { randomUUID } from 'node:crypto'
import { LockMode, UniqueConstraintViolationException } from '@mikro-orm/core'
import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import {
  CustomerRole,
  CustomerUser,
  CustomerUserRole,
} from '@open-mercato/core/modules/customer_accounts/data/entities'
import {
  CustomerEntity,
  CustomerPersonProfile,
} from '@open-mercato/core/modules/customers/data/entities'
import { hashForLookup, lookupHashCandidates } from '@open-mercato/shared/lib/encryption/aes'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { FinooIntermediary } from '../data/entities'

const INTERMEDIARY_ENTITY_TYPE = 'finoo_intermediaries:finoo_intermediary'
const INTERMEDIARY_ROLE_SLUG = 'intermediary'

const logger = createLogger('finoo_intermediaries').child({ component: 'directoryBackfill' })

export type IntermediaryBackfillMode = 'dry-run' | 'apply'

export type IntermediaryBackfillScope = {
  tenantId: string
  organizationId: string
}

type QueryIndexEventBus = {
  emitEvent(event: string, payload: unknown, options?: unknown): Promise<void>
}

type BackfillUser = Pick<
  CustomerUser,
  'id' | 'email' | 'emailHash' | 'displayName' | 'personEntityId'
>

type BackfillProfile = Pick<CustomerPersonProfile, 'firstName' | 'lastName'>

type ExistingDirectoryRow = Pick<
  FinooIntermediary,
  'id' | 'customerUserId' | 'emailHash' | 'lifecycleState' | 'firstName' | 'lastName'
>

export type IntermediaryBackfillCreate = {
  action: 'create'
  customerUserId: string
  email: string
  emailHash: string
  firstName: string
  lastName: string
}

export type IntermediaryBackfillUnchanged = {
  action: 'unchanged'
  customerUserId: string
  intermediaryId: string
}

export type IntermediaryBackfillEntry = IntermediaryBackfillCreate | IntermediaryBackfillUnchanged

export type IntermediaryBackfillPlan = {
  roleId: string
  entries: IntermediaryBackfillEntry[]
}

export type IntermediaryBackfillReport = {
  mode: IntermediaryBackfillMode
  tenantId: string
  organizationId: string
  roleId: string
  counts: {
    eligible: number
    plannedCreates: number
    created: number
    unchanged: number
  }
  records: Array<{
    customerUserId: string
    code: 'would_create' | 'created' | 'unchanged'
  }>
}

export class IntermediaryBackfillError extends Error {
  constructor(readonly code: string) {
    super(`[internal] FINOO intermediary directory backfill failed: ${code}`)
    this.name = 'IntermediaryBackfillError'
  }
}

function fail(code: string): never {
  throw new IntermediaryBackfillError(code)
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function deriveIntermediaryBackfillName(input: {
  displayName: string
  profile?: BackfillProfile | null
}): { firstName: string; lastName: string } {
  const profileFirstName = input.profile?.firstName?.trim() ?? ''
  const profileLastName = input.profile?.lastName?.trim() ?? ''
  if (profileFirstName && profileLastName) {
    return { firstName: profileFirstName, lastName: profileLastName }
  }

  const match = /^(.*\S)\s+(\S+)$/.exec(input.displayName.trim())
  if (!match) fail('name_unresolvable')
  const firstName = match[1].trim()
  const lastName = match[2].trim()
  if (!firstName || !lastName) fail('name_unresolvable')
  return { firstName, lastName }
}

export function planIntermediaryDirectoryBackfill(input: {
  roleId: string
  users: BackfillUser[]
  profilesByUserId: Map<string, BackfillProfile | null>
  existingRows: ExistingDirectoryRow[]
}): IntermediaryBackfillPlan {
  const entries: IntermediaryBackfillEntry[] = []
  const sortedUsers = [...input.users].sort((left, right) => left.id.localeCompare(right.id))
  if (new Set(sortedUsers.map((user) => user.id)).size !== sortedUsers.length) {
    fail('customer_user_ambiguous')
  }
  const emailHashOwners = new Map<string, string>()
  for (const user of sortedUsers) {
    for (const candidate of lookupHashCandidates(normalizeEmail(user.email))) {
      const owner = emailHashOwners.get(candidate)
      if (owner && owner !== user.id) fail('customer_user_email_conflict')
      emailHashOwners.set(candidate, user.id)
    }
  }

  for (const user of sortedUsers) {
    const email = normalizeEmail(user.email)
    const emailHashCandidates = lookupHashCandidates(email)
    const matchedByUser = input.existingRows.filter((row) => row.customerUserId === user.id)
    const matchedByEmail = input.existingRows.filter((row) => emailHashCandidates.includes(row.emailHash))
    if (matchedByUser.length > 1 || matchedByEmail.length > 1) fail('directory_match_ambiguous')

    const userMatch = matchedByUser[0] ?? null
    const emailMatch = matchedByEmail[0] ?? null
    if (!userMatch && !emailMatch) {
      const name = deriveIntermediaryBackfillName({
        displayName: user.displayName,
        profile: input.profilesByUserId.get(user.id) ?? null,
      })
      entries.push({
        action: 'create',
        customerUserId: user.id,
        email,
        emailHash: hashForLookup(email),
        ...name,
      })
      continue
    }

    if (
      !userMatch
      || !emailMatch
      || userMatch.id !== emailMatch.id
      || userMatch.customerUserId !== user.id
      || userMatch.lifecycleState !== 'active'
    ) {
      fail('directory_match_conflict')
    }
    entries.push({ action: 'unchanged', customerUserId: user.id, intermediaryId: userMatch.id })
  }

  return { roleId: input.roleId, entries }
}

function lockOptions(lock: boolean): { lockMode: LockMode.PESSIMISTIC_READ } | undefined {
  return lock ? { lockMode: LockMode.PESSIMISTIC_READ } : undefined
}

async function loadScopedRole(
  em: EntityManager,
  scope: IntermediaryBackfillScope,
  lock: boolean,
): Promise<CustomerRole> {
  const roles = await findWithDecryption(
    em,
    CustomerRole,
    {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      slug: INTERMEDIARY_ROLE_SLUG,
      deletedAt: null,
    } as FilterQuery<CustomerRole>,
    lockOptions(lock),
    scope,
  )
  return requireSingleScopedIntermediaryRole(roles)
}

export function requireSingleScopedIntermediaryRole(roles: CustomerRole[]): CustomerRole {
  if (roles.length !== 1) fail('role_missing_or_ambiguous')
  return roles[0]
}

async function loadEligibleUsers(
  em: EntityManager,
  role: CustomerRole,
  scope: IntermediaryBackfillScope,
  lock: boolean,
): Promise<CustomerUser[]> {
  const memberships = await em.find(
    CustomerUserRole,
    { role: role.id, deletedAt: null } as FilterQuery<CustomerUserRole>,
    { populate: ['user'], ...lockOptions(lock) },
  )
  const membershipUserIds = memberships.map((membership) => membership.user.id)
  if (new Set(membershipUserIds).size !== membershipUserIds.length) fail('membership_ambiguous')
  if (membershipUserIds.length === 0) return []

  const users = await findWithDecryption(
    em,
    CustomerUser,
    {
      id: { $in: membershipUserIds },
      tenantId: scope.tenantId,
      deletedAt: null,
    } as FilterQuery<CustomerUser>,
    lockOptions(lock),
    { tenantId: scope.tenantId },
  )
  if (users.length !== membershipUserIds.length) fail('membership_user_missing')
  if (users.some((user) => user.organizationId !== scope.organizationId)) {
    fail('membership_user_scope_conflict')
  }
  return users.filter((user) => user.isActive)
}

async function loadProfilesByUserId(
  em: EntityManager,
  users: CustomerUser[],
  scope: IntermediaryBackfillScope,
  lock: boolean,
): Promise<Map<string, BackfillProfile | null>> {
  const personEntityIds = [...new Set(users.flatMap((user) => user.personEntityId ? [user.personEntityId] : []))]
  if (personEntityIds.length === 0) return new Map()

  const people = await findWithDecryption(
    em,
    CustomerEntity,
    { id: { $in: personEntityIds }, tenantId: scope.tenantId } as FilterQuery<CustomerEntity>,
    lockOptions(lock),
    { tenantId: scope.tenantId },
  )
  const peopleById = new Map(people.map((person) => [person.id, person]))
  for (const personEntityId of personEntityIds) {
    const person = peopleById.get(personEntityId)
    if (
      !person
      || person.organizationId !== scope.organizationId
      || person.kind !== 'person'
      || person.deletedAt
    ) {
      fail('person_scope_conflict')
    }
  }

  const profiles = await findWithDecryption(
    em,
    CustomerPersonProfile,
    {
      entity: { $in: personEntityIds },
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
    } as FilterQuery<CustomerPersonProfile>,
    { populate: ['entity'], ...lockOptions(lock) },
    scope,
  )
  const profileByEntityId = new Map<string, CustomerPersonProfile>()
  for (const profile of profiles) {
    if (profileByEntityId.has(profile.entity.id)) fail('person_profile_ambiguous')
    profileByEntityId.set(profile.entity.id, profile)
  }

  return new Map(users.map((user) => [
    user.id,
    user.personEntityId ? profileByEntityId.get(user.personEntityId) ?? null : null,
  ]))
}

async function loadExistingRows(
  em: EntityManager,
  users: CustomerUser[],
  scope: IntermediaryBackfillScope,
  lock: boolean,
): Promise<FinooIntermediary[]> {
  if (users.length === 0) return []
  const userIds = users.map((user) => user.id)
  const emailHashCandidates = [...new Set(users.flatMap((user) => lookupHashCandidates(normalizeEmail(user.email))))]
  return findWithDecryption(
    em,
    FinooIntermediary,
    {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      deletedAt: null,
      $or: [
        { customerUserId: { $in: userIds } },
        { emailHash: { $in: emailHashCandidates } },
      ],
    } as FilterQuery<FinooIntermediary>,
    lockOptions(lock),
    scope,
  )
}

export async function loadIntermediaryDirectoryBackfillPlan(
  em: EntityManager,
  scope: IntermediaryBackfillScope,
  options: { lock: boolean },
): Promise<IntermediaryBackfillPlan> {
  const role = await loadScopedRole(em, scope, options.lock)
  const users = await loadEligibleUsers(em, role, scope, options.lock)
  const profilesByUserId = await loadProfilesByUserId(em, users, scope, options.lock)
  const existingRows = await loadExistingRows(em, users, scope, options.lock)
  return planIntermediaryDirectoryBackfill({
    roleId: role.id,
    users,
    profilesByUserId,
    existingRows,
  })
}

function createIntermediary(
  em: EntityManager,
  scope: IntermediaryBackfillScope,
  entry: IntermediaryBackfillCreate,
  now: Date,
): FinooIntermediary {
  const intermediaryClass = em.getMetadata().getByClassName<FinooIntermediary>('FinooIntermediary').class
  const intermediary = em.create(intermediaryClass, {
    id: randomUUID(),
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    firstName: entry.firstName,
    lastName: entry.lastName,
    email: entry.email,
    emailHash: entry.emailHash,
    lifecycleState: 'active',
    customerUserId: entry.customerUserId,
    activatedAt: now,
    createdByUserId: null,
    updatedByUserId: null,
    createdAt: now,
    updatedAt: now,
  })
  em.persist(intermediary)
  return intermediary
}

function buildReport(input: {
  mode: IntermediaryBackfillMode
  scope: IntermediaryBackfillScope
  plan: IntermediaryBackfillPlan
  created: number
}): IntermediaryBackfillReport {
  const plannedCreates = input.plan.entries.filter((entry) => entry.action === 'create').length
  const unchanged = input.plan.entries.length - plannedCreates
  return {
    mode: input.mode,
    tenantId: input.scope.tenantId,
    organizationId: input.scope.organizationId,
    roleId: input.plan.roleId,
    counts: {
      eligible: input.plan.entries.length,
      plannedCreates,
      created: input.created,
      unchanged,
    },
    records: input.plan.entries.map((entry) => ({
      customerUserId: entry.customerUserId,
      code: entry.action === 'unchanged'
        ? 'unchanged'
        : input.mode === 'dry-run'
          ? 'would_create'
          : 'created',
    })),
  }
}

async function emitCreatedIndexes(
  eventBus: QueryIndexEventBus | undefined,
  rows: FinooIntermediary[],
): Promise<void> {
  if (!eventBus) return
  for (const row of rows) {
    await eventBus.emitEvent('query_index.upsert_one', {
      entityType: INTERMEDIARY_ENTITY_TYPE,
      recordId: row.id,
      tenantId: row.tenantId,
      organizationId: row.organizationId,
      crudAction: 'created',
    }, {
      tenantId: row.tenantId,
      organizationId: row.organizationId,
    }).catch(() => {
      logger.warn('Intermediary backfill query index upsert failed', {
        intermediaryId: row.id,
        tenantId: row.tenantId,
        organizationId: row.organizationId,
      })
    })
  }
}

export async function backfillIntermediaryDirectory(input: {
  em: EntityManager
  eventBus?: QueryIndexEventBus
  scope: IntermediaryBackfillScope
  mode: IntermediaryBackfillMode
  now?: Date
}, dependencies: {
  loadPlan?: typeof loadIntermediaryDirectoryBackfillPlan
} = {}): Promise<IntermediaryBackfillReport> {
  const loadPlan = dependencies.loadPlan ?? loadIntermediaryDirectoryBackfillPlan
  if (input.mode === 'dry-run') {
    const plan = await loadPlan(input.em, input.scope, { lock: false })
    return buildReport({ mode: input.mode, scope: input.scope, plan, created: 0 })
  }

  const now = input.now ?? new Date()
  let outcome: { plan: IntermediaryBackfillPlan; createdRows: FinooIntermediary[] }
  try {
    outcome = await input.em.transactional(async (transactionalEm) => {
      const plan = await loadPlan(
        transactionalEm,
        input.scope,
        { lock: true },
      )
      const createdRows = plan.entries
        .filter((entry): entry is IntermediaryBackfillCreate => entry.action === 'create')
        .map((entry) => createIntermediary(transactionalEm, input.scope, entry, now))
      if (createdRows.length > 0) await transactionalEm.flush()
      return { plan, createdRows }
    })
  } catch (error) {
    if (error instanceof UniqueConstraintViolationException) fail('concurrent_directory_conflict')
    throw error
  }

  await emitCreatedIndexes(input.eventBus, outcome.createdRows)
  return buildReport({
    mode: input.mode,
    scope: input.scope,
    plan: outcome.plan,
    created: outcome.createdRows.length,
  })
}
