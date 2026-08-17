import { LockMode } from '@mikro-orm/core'
import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import {
  CustomerRole,
  CustomerUser,
  CustomerUserInvitation,
  CustomerUserRole,
  CustomerUserSession,
} from '@open-mercato/core/modules/customer_accounts/data/entities'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { hashForLookup, lookupHashCandidates } from '@open-mercato/shared/lib/encryption/aes'
import { findOneWithDecryption, findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { FinooIntermediary } from '../data/entities'

export type IntermediaryDirectoryScope = {
  tenantId: string
  organizationId: string
}

export function normalizeIntermediaryEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function intermediaryEmailHash(email: string): string {
  return hashForLookup(normalizeIntermediaryEmail(email))
}

export function directoryNotFound(): CrudHttpError {
  return new CrudHttpError(404, { error: 'Resource not found' })
}

export function directoryConflict(code: string): CrudHttpError {
  return new CrudHttpError(409, { error: 'Intermediary lifecycle conflict', code })
}

export async function loadIntermediaryRole(
  em: EntityManager,
  scope: IntermediaryDirectoryScope,
): Promise<CustomerRole> {
  const roles = await findWithDecryption(
    em,
    CustomerRole,
    {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      slug: 'intermediary',
      deletedAt: null,
    } as FilterQuery<CustomerRole>,
    undefined,
    scope,
  )
  if (roles.length !== 1) {
    throw new CrudHttpError(422, {
      error: 'Intermediary role configuration is ambiguous or missing',
      code: 'intermediary_role_configuration',
    })
  }
  return roles[0]
}

export async function loadDirectoryById(
  em: EntityManager,
  id: string,
  scope: IntermediaryDirectoryScope,
  lock = false,
): Promise<FinooIntermediary> {
  const intermediary = await findOneWithDecryption(
    em,
    FinooIntermediary,
    {
      id,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      deletedAt: null,
    } as FilterQuery<FinooIntermediary>,
    lock ? { lockMode: LockMode.PESSIMISTIC_WRITE } : undefined,
    scope,
  )
  if (!intermediary) throw directoryNotFound()
  return intermediary
}

export async function loadDirectoryByEmail(
  em: EntityManager,
  email: string,
  scope: IntermediaryDirectoryScope,
  lock = false,
): Promise<FinooIntermediary | null> {
  return findOneWithDecryption(
    em,
    FinooIntermediary,
    {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      emailHash: { $in: lookupHashCandidates(normalizeIntermediaryEmail(email)) },
      deletedAt: null,
    } as FilterQuery<FinooIntermediary>,
    lock ? { lockMode: LockMode.PESSIMISTIC_WRITE } : undefined,
    scope,
  )
}

export async function loadScopedCustomerUserByEmail(
  em: EntityManager,
  email: string,
  scope: IntermediaryDirectoryScope,
  lock = false,
): Promise<CustomerUser | null> {
  const hashCandidates = lookupHashCandidates(normalizeIntermediaryEmail(email))
  const user = await findOneWithDecryption(
    em,
    CustomerUser,
    {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      emailHash: { $in: hashCandidates },
      deletedAt: null,
    } as FilterQuery<CustomerUser>,
    lock ? { lockMode: LockMode.PESSIMISTIC_WRITE } : undefined,
    scope,
  )
  if (user) return user

  const foreignCount = await em.count(CustomerUser, {
    tenantId: scope.tenantId,
    organizationId: { $ne: scope.organizationId },
    emailHash: { $in: hashCandidates },
    deletedAt: null,
  } as FilterQuery<CustomerUser>)
  if (foreignCount > 0) throw directoryConflict('scoped_email_conflict')
  return null
}

export async function loadScopedCustomerUser(
  em: EntityManager,
  userId: string,
  scope: IntermediaryDirectoryScope,
  lock = false,
): Promise<CustomerUser> {
  const user = await findOneWithDecryption(
    em,
    CustomerUser,
    {
      id: userId,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      deletedAt: null,
    } as FilterQuery<CustomerUser>,
    lock ? { lockMode: LockMode.PESSIMISTIC_WRITE } : undefined,
    scope,
  )
  if (!user) throw directoryNotFound()
  return user
}

export async function loadCurrentInvitation(
  em: EntityManager,
  invitationId: string,
  scope: IntermediaryDirectoryScope,
  lock = false,
): Promise<CustomerUserInvitation | null> {
  return findOneWithDecryption(
    em,
    CustomerUserInvitation,
    {
      id: invitationId,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
    } as FilterQuery<CustomerUserInvitation>,
    lock ? { lockMode: LockMode.PESSIMISTIC_WRITE } : undefined,
    scope,
  )
}

export async function requireCurrentInvitation(
  em: EntityManager,
  intermediary: FinooIntermediary,
  scope: IntermediaryDirectoryScope,
): Promise<CustomerUserInvitation> {
  if (!intermediary.invitationId) throw directoryConflict('invitation_missing')
  const invitation = await loadCurrentInvitation(em, intermediary.invitationId, scope, true)
  if (!invitation) throw directoryConflict('invitation_missing')
  return invitation
}

export async function loadIntermediaryMembership(
  em: EntityManager,
  user: CustomerUser,
  role: CustomerRole,
  lock = false,
): Promise<CustomerUserRole | null> {
  return em.findOne(
    CustomerUserRole,
    { user, role } as FilterQuery<CustomerUserRole>,
    lock ? { lockMode: LockMode.PESSIMISTIC_WRITE } : undefined,
  )
}

export async function restoreIntermediaryMembership(
  em: EntityManager,
  user: CustomerUser,
  role: CustomerRole,
): Promise<{ membership: CustomerUserRole; changed: boolean }> {
  const existing = await loadIntermediaryMembership(em, user, role, true)
  if (existing) {
    const changed = existing.deletedAt !== null && existing.deletedAt !== undefined
    existing.deletedAt = null
    return { membership: existing, changed }
  }
  const membership = new CustomerUserRole()
  membership.user = user
  membership.role = role
  membership.createdAt = new Date()
  em.persist(membership)
  return { membership, changed: true }
}

export async function lockActiveUserSessions(
  em: EntityManager,
  user: CustomerUser,
  scope: IntermediaryDirectoryScope,
): Promise<CustomerUserSession[]> {
  return findWithDecryption(
    em,
    CustomerUserSession,
    { user, deletedAt: null } as FilterQuery<CustomerUserSession>,
    { lockMode: LockMode.PESSIMISTIC_WRITE },
    scope,
  )
}
