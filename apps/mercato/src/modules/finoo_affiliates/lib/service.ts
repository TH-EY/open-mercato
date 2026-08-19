import type { EntityManager } from '@mikro-orm/postgresql'
import { findOneWithDecryption, findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { CustomerRole, CustomerUser, CustomerUserRole } from '@open-mercato/core/modules/customer_accounts/data/entities'
import { Dictionary, DictionaryEntry } from '@open-mercato/core/modules/dictionaries/data/entities'
import {
  FinooAffiliateLink,
  FinooAffiliateVisit,
  FinooDealAttribution,
  type FinooCommissionStatus,
} from '../data/entities'
import { FINOO_COMMISSION_STATUS_DICTIONARY_KEY } from '../setup'
import { parseAllowedRedirectHosts, validateAffiliateDestination } from './tracking'
import { FINOO_AFFILIATE_VISITOR_WINDOW_MS } from './visitRetention'
import { generateAffiliateCode, withReservedAffiliateCode } from './membership'

export type FinooScope = { tenantId: string; organizationId: string }

export function createAffiliateCode(): string {
  return generateAffiliateCode()
}

export function createFinooAffiliateService(em: EntityManager) {
  const allowLocalhost = process.env.NODE_ENV !== 'production' || process.env.OM_INTEGRATION_TEST === 'true'
  const allowedHosts = parseAllowedRedirectHosts(process.env.OM_FINOO_AFFILIATE_REDIRECT_HOSTS)

  async function requireAffiliateUser(userId: string, scope: FinooScope): Promise<CustomerUser> {
    const user = await findOneWithDecryption(
      em,
      CustomerUser,
      { id: userId, tenantId: scope.tenantId, organizationId: scope.organizationId, isActive: true, deletedAt: null },
      undefined,
      scope,
    )
    if (!user) throw new Error('[internal] Affiliate portal user was not found')
    const role = await findOneWithDecryption(
      em,
      CustomerRole,
      { tenantId: scope.tenantId, organizationId: scope.organizationId, slug: 'affiliate', deletedAt: null },
      undefined,
      scope,
    )
    if (!role) throw new Error('[internal] Affiliate portal role was not found')
    const assignment = await findOneWithDecryption(
      em,
      CustomerUserRole,
      { user: user.id, role: role.id, deletedAt: null },
      undefined,
      scope,
    )
    if (!assignment) throw new Error('[internal] Portal user does not have the affiliate role')
    return user
  }

  async function listAffiliateUsers(scope: FinooScope): Promise<CustomerUser[]> {
    const role = await findOneWithDecryption(
      em,
      CustomerRole,
      { tenantId: scope.tenantId, organizationId: scope.organizationId, slug: 'affiliate', deletedAt: null },
      undefined,
      scope,
    )
    if (!role) return []
    const assignments = await findWithDecryption(
      em,
      CustomerUserRole,
      { role: role.id, deletedAt: null },
      { populate: ['user'] },
      scope,
    )
    return assignments
      .map((assignment) => assignment.user)
      .filter((user) => user.tenantId === scope.tenantId && user.organizationId === scope.organizationId && user.isActive && !user.deletedAt)
  }

  async function requireCommissionStatus(entryId: string, scope: FinooScope): Promise<{ entry: DictionaryEntry; status: FinooCommissionStatus }> {
    const dictionary = await findOneWithDecryption(
      em,
      Dictionary,
      { tenantId: scope.tenantId, organizationId: scope.organizationId, key: FINOO_COMMISSION_STATUS_DICTIONARY_KEY, isActive: true, deletedAt: null },
      undefined,
      scope,
    )
    if (!dictionary) throw new Error('[internal] Commission status dictionary was not found')
    const entry = await findOneWithDecryption(
      em,
      DictionaryEntry,
      { id: entryId, dictionary: dictionary.id, tenantId: scope.tenantId, organizationId: scope.organizationId },
      undefined,
      scope,
    )
    const normalized = entry?.normalizedValue
    if (!entry || (normalized !== 'approved' && normalized !== 'waiting' && normalized !== 'rejected')) {
      throw new Error('[internal] Commission status entry is invalid')
    }
    return { entry, status: normalized }
  }

  async function getDefaultCommissionStatus(scope: FinooScope): Promise<{ entry: DictionaryEntry; status: FinooCommissionStatus }> {
    const dictionary = await findOneWithDecryption(
      em,
      Dictionary,
      { tenantId: scope.tenantId, organizationId: scope.organizationId, key: FINOO_COMMISSION_STATUS_DICTIONARY_KEY, isActive: true, deletedAt: null },
      undefined,
      scope,
    )
    if (!dictionary) throw new Error('[internal] Commission status dictionary was not found')
    const entry = await findOneWithDecryption(
      em,
      DictionaryEntry,
      { dictionary: dictionary.id, tenantId: scope.tenantId, organizationId: scope.organizationId, normalizedValue: 'waiting' },
      undefined,
      scope,
    )
    if (!entry) throw new Error('[internal] Waiting commission status entry was not found')
    return { entry, status: 'waiting' }
  }

  async function requireAllowedDestination(rawUrl: string): Promise<string> {
    return validateAffiliateDestination(rawUrl, { allowedHosts, allowLocalhost }).toString()
  }

  async function findActiveLinkByCode(code: string): Promise<FinooAffiliateLink | null> {
    return findOneWithDecryption(em, FinooAffiliateLink, { code, isActive: true, deletedAt: null }, undefined, {})
  }

  async function findActiveLinkByCodeInScope(code: string, scope: FinooScope): Promise<FinooAffiliateLink | null> {
    return findOneWithDecryption(
      em,
      FinooAffiliateLink,
      { code, tenantId: scope.tenantId, organizationId: scope.organizationId, isActive: true, deletedAt: null },
      undefined,
      scope,
    )
  }

  async function recordUniqueVisit(link: FinooAffiliateLink, visitorHash: string, now: Date): Promise<boolean> {
    return em.transactional(async (transactionalEm) => {
      await transactionalEm.getConnection().execute(
        'select pg_advisory_xact_lock(hashtextextended(?, 0))',
        [`${link.id}:${visitorHash}`],
      )
      const cutoff = new Date(now.getTime() - FINOO_AFFILIATE_VISITOR_WINDOW_MS)
      await transactionalEm.nativeUpdate(
        FinooAffiliateVisit,
        {
          affiliateLinkId: link.id,
          tenantId: link.tenantId,
          organizationId: link.organizationId,
          visitorHash: { $ne: null },
          visitedAt: { $lt: cutoff },
        },
        { visitorHash: null },
      )
      const existing = await findOneWithDecryption(
        transactionalEm,
        FinooAffiliateVisit,
        {
          affiliateLinkId: link.id,
          visitorHash,
          visitedAt: { $gte: cutoff },
          tenantId: link.tenantId,
          organizationId: link.organizationId,
        },
        { orderBy: { visitedAt: 'DESC' } },
        { tenantId: link.tenantId, organizationId: link.organizationId },
      )
      if (existing) return false
      transactionalEm.persist(transactionalEm.create(FinooAffiliateVisit, {
        tenantId: link.tenantId,
        organizationId: link.organizationId,
        affiliateLinkId: link.id,
        affiliateUserId: link.affiliateUserId,
        visitorHash,
        visitedAt: now,
      }))
      await transactionalEm.flush()
      return true
    })
  }

  async function listCommissionStatuses(scope: FinooScope): Promise<DictionaryEntry[]> {
    const dictionary = await findOneWithDecryption(
      em,
      Dictionary,
      { tenantId: scope.tenantId, organizationId: scope.organizationId, key: FINOO_COMMISSION_STATUS_DICTIONARY_KEY, isActive: true, deletedAt: null },
      undefined,
      scope,
    )
    if (!dictionary) return []
    return findWithDecryption(
      em,
      DictionaryEntry,
      { dictionary: dictionary.id, tenantId: scope.tenantId, organizationId: scope.organizationId },
      { orderBy: { position: 'ASC' } },
      scope,
    )
  }

  async function withAvailableAffiliateCode<T>(create: (transactionalEm: EntityManager, code: string) => Promise<T>): Promise<T> {
    return withReservedAffiliateCode(em, create)
  }

  return {
    requireAffiliateUser,
    listAffiliateUsers,
    requireCommissionStatus,
    getDefaultCommissionStatus,
    requireAllowedDestination,
    findActiveLinkByCode,
    findActiveLinkByCodeInScope,
    recordUniqueVisit,
    listCommissionStatuses,
    withAvailableAffiliateCode,
  }
}

type FinooAffiliateServiceImplementation = ReturnType<typeof createFinooAffiliateService>

export type FinooAffiliateService = Omit<FinooAffiliateServiceImplementation, 'findActiveLinkByCodeInScope'> & {
  findActiveLinkByCodeInScope?: FinooAffiliateServiceImplementation['findActiveLinkByCodeInScope']
}
