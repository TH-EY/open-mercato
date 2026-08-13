import { randomBytes } from 'node:crypto'
import { LockMode, type EntityManager } from '@mikro-orm/postgresql'
import { CustomerRole, CustomerUser, CustomerUserInvitation, CustomerUserRole } from '@open-mercato/core/modules/customer_accounts/data/entities'
import { hashForLookup, lookupHashCandidates } from '@open-mercato/shared/lib/encryption/aes'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { FinooAffiliate, FinooAffiliateLink } from '../data/entities'
import type { FinooScope } from './service'
import { parseAllowedRedirectHosts, validateAffiliateDestination } from './tracking'

const AFFILIATE_ROLE_SLUG = 'affiliate'
const AFFILIATE_CODE_BYTES = 12
const CODE_ATTEMPTS = 8
const CODE_RESERVATION_LOCK = 'finoo_affiliates:code-reservation'

export type EnsureAffiliateResult = { affiliate: FinooAffiliate; created: boolean }
export type ActivateAffiliateResult = { affiliate: FinooAffiliate; link: FinooAffiliateLink; activated: boolean }

export function normalizeAffiliateEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function generateAffiliateCode(): string {
  return randomBytes(AFFILIATE_CODE_BYTES).toString('hex').toUpperCase()
}

export function resolveDefaultAffiliateDestination(): string {
  const raw = process.env.OM_FINOO_DEFAULT_AFFILIATE_DESTINATION_URL?.trim()
    || (process.env.OM_INTEGRATION_TEST === 'true' ? 'http://localhost/' : '')
  if (!raw) throw new CrudHttpError(409, { error: 'AFFILIATE_DESTINATION_NOT_CONFIGURED' })
  const allowedHosts = parseAllowedRedirectHosts(process.env.OM_FINOO_AFFILIATE_REDIRECT_HOSTS)
  const allowLocalhost = process.env.NODE_ENV !== 'production' || process.env.OM_INTEGRATION_TEST === 'true'
  return validateAffiliateDestination(raw, { allowedHosts, allowLocalhost }).toString()
}

export async function loadAffiliateRole(em: EntityManager, tenantId: string): Promise<CustomerRole | null> {
  return findOneWithDecryption(
    em,
    CustomerRole,
    { tenantId, slug: AFFILIATE_ROLE_SLUG, deletedAt: null },
    undefined,
    { tenantId, organizationId: null },
  )
}

async function lockCodeReservation(em: EntityManager): Promise<void> {
  await em.getConnection().execute(
    'select pg_advisory_xact_lock(hashtextextended(?, 0))',
    [CODE_RESERVATION_LOCK],
  )
}

async function reserveUniqueCode(em: EntityManager): Promise<string> {
  for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt += 1) {
    const code = generateAffiliateCode()
    const [affiliate, link] = await Promise.all([
      findOneWithDecryption(em, FinooAffiliate, { code }, undefined, {}),
      findOneWithDecryption(em, FinooAffiliateLink, { code }, undefined, {}),
    ])
    if (!affiliate && !link) return code
  }
  throw new CrudHttpError(409, { error: 'AFFILIATE_CODE_RESERVATION_FAILED' })
}

async function ensureAffiliateForInvitationLocked(
  em: EntityManager,
  invitationId: string,
  scope: FinooScope,
): Promise<EnsureAffiliateResult> {
    const invitation = await findOneWithDecryption(
      em,
      CustomerUserInvitation,
      { id: invitationId, tenantId: scope.tenantId, organizationId: scope.organizationId },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
      scope,
    )
    if (!invitation) throw new CrudHttpError(404, { error: 'INVITATION_NOT_FOUND' })

    const role = await loadAffiliateRole(em, scope.tenantId)
    if (!role || !Array.isArray(invitation.roleIdsJson) || !invitation.roleIdsJson.includes(role.id)) {
      throw new CrudHttpError(409, { error: 'INVITATION_NOT_FOR_AFFILIATE' })
    }

    const byInvitation = await findOneWithDecryption(
      em,
      FinooAffiliate,
      { invitationId: invitation.id, ...scope, deletedAt: null },
      undefined,
      scope,
    )
    if (byInvitation) return { affiliate: byInvitation, created: false }

    const normalizedEmail = normalizeAffiliateEmail(invitation.email)
    const emailHashes = lookupHashCandidates(normalizedEmail)
    const byEmail = await findOneWithDecryption(
      em,
      FinooAffiliate,
      { emailHash: { $in: emailHashes }, ...scope, deletedAt: null },
      undefined,
      scope,
    )
    if (byEmail) {
      byEmail.invitationId = invitation.id
      await em.flush()
      return { affiliate: byEmail, created: false }
    }

    const affiliate = em.create(FinooAffiliate, {
      ...scope,
      invitationId: invitation.id,
      email: normalizedEmail,
      emailHash: hashForLookup(normalizedEmail),
      code: await reserveUniqueCode(em),
      isActive: false,
    })
    em.persist(affiliate)
    await em.flush()
    return { affiliate, created: true }
}

export async function ensureAffiliateForInvitation(
  em: EntityManager,
  invitationId: string,
  scope: FinooScope,
): Promise<EnsureAffiliateResult> {
  return em.transactional(async (transactionalEm) => {
    await lockCodeReservation(transactionalEm)
    return ensureAffiliateForInvitationLocked(transactionalEm, invitationId, scope)
  })
}

export async function activateAffiliateForInvitation(
  em: EntityManager,
  invitationId: string,
  userId: string,
  scope: FinooScope,
): Promise<ActivateAffiliateResult> {
  return em.transactional(async (transactionalEm) => {
    await lockCodeReservation(transactionalEm)
    const invitation = await findOneWithDecryption(
      transactionalEm,
      CustomerUserInvitation,
      { id: invitationId, tenantId: scope.tenantId, organizationId: scope.organizationId },
      undefined,
      scope,
    )
    if (!invitation?.acceptedAt) throw new CrudHttpError(409, { error: 'INVITATION_NOT_ACCEPTED' })
    const ensured = await ensureAffiliateForInvitationLocked(transactionalEm, invitation.id, scope)
    const user = await findOneWithDecryption(
    transactionalEm,
    CustomerUser,
    { id: userId, ...scope, isActive: true, deletedAt: null },
    undefined,
    scope,
  )
  if (!user || !lookupHashCandidates(invitation.email).includes(user.emailHash)) {
    throw new CrudHttpError(409, { error: 'INVITATION_USER_MISMATCH' })
  }
    const role = await loadAffiliateRole(transactionalEm, scope.tenantId)
  if (!role) throw new CrudHttpError(409, { error: 'AFFILIATE_ROLE_NOT_FOUND' })
  const assignment = await findOneWithDecryption(
    transactionalEm,
    CustomerUserRole,
    { user: user.id, role: role.id, deletedAt: null },
    undefined,
    scope,
  )
  if (!assignment) throw new CrudHttpError(409, { error: 'USER_NOT_AFFILIATE' })

  const affiliate = ensured.affiliate
  const destinationUrl = resolveDefaultAffiliateDestination()
    let link = affiliate.primaryLinkId
    ? await findOneWithDecryption(transactionalEm, FinooAffiliateLink, { id: affiliate.primaryLinkId, ...scope, deletedAt: null }, undefined, scope)
    : null
  if (!link) {
    link = await findOneWithDecryption(
      transactionalEm,
      FinooAffiliateLink,
      { code: affiliate.code, ...scope, deletedAt: null },
      undefined,
      scope,
    )
  }
  if (!link) {
    link = transactionalEm.create(FinooAffiliateLink, {
      ...scope,
      affiliateId: affiliate.id,
      affiliateUserId: user.id,
      code: affiliate.code,
      label: 'Primary affiliate link',
      destinationUrl,
      isActive: true,
    })
    transactionalEm.persist(link)
    await transactionalEm.flush()
  } else {
    link.affiliateId = affiliate.id
    link.affiliateUserId = user.id
    link.destinationUrl = destinationUrl
    link.isActive = true
  }
  const activated = !affiliate.isActive || affiliate.customerUserId !== user.id || affiliate.primaryLinkId !== link.id
  affiliate.customerUserId = user.id
  affiliate.primaryLinkId = link.id
  affiliate.isActive = true
    await transactionalEm.flush()
    return { affiliate, link, activated }
  })
}

export async function reconcileAffiliateForUser(
  em: EntityManager,
  userId: string,
  scope: FinooScope,
  activate: (invitationId: string, userId: string, scope: FinooScope) => Promise<FinooAffiliate>,
): Promise<FinooAffiliate | null> {
  const active = await findOneWithDecryption(
    em,
    FinooAffiliate,
    { customerUserId: userId, ...scope, isActive: true, deletedAt: null },
    undefined,
    scope,
  )
  if (active) return active
  const user = await findOneWithDecryption(em, CustomerUser, { id: userId, ...scope, isActive: true, deletedAt: null }, undefined, scope)
  if (!user) return null
  const invitation = await findOneWithDecryption(
    em,
    CustomerUserInvitation,
    { emailHash: { $in: lookupHashCandidates(user.email) }, ...scope, acceptedAt: { $ne: null } },
    { orderBy: { createdAt: 'DESC' } },
    scope,
  )
  if (!invitation) return null
  return activate(invitation.id, user.id, scope)
}

export async function withReservedAffiliateCode<T>(
  em: EntityManager,
  create: (transactionalEm: EntityManager, code: string) => Promise<T>,
): Promise<T> {
  return em.transactional(async (transactionalEm) => {
    await lockCodeReservation(transactionalEm)
    return create(transactionalEm, await reserveUniqueCode(transactionalEm))
  })
}
