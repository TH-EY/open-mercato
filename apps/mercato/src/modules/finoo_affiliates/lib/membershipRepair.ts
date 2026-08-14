import type { EntityManager } from '@mikro-orm/postgresql'
import { CustomerUserRole } from '@open-mercato/core/modules/customer_accounts/data/entities'
import { hashForLookup, lookupHashCandidates } from '@open-mercato/shared/lib/encryption/aes'
import { findOneWithDecryption, findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { FinooAffiliate, FinooAffiliateLink, FinooDealAttribution } from '../data/entities'
import { loadAffiliateRole, normalizeAffiliateEmail, resolveDefaultAffiliateDestination, withReservedAffiliateCode } from './membership'
import type { FinooScope } from './service'

export type MembershipRepairResult = {
  batchesProcessed: number
  usersScanned: number
  membershipsCreated: number
  linksAdopted: number
  linksCreated: number
  attributionsLinked: number
}

export const FINOO_MEMBERSHIP_REPAIR_BATCH_SIZE = 100

export async function repairAffiliateMemberships(
  em: EntityManager,
  scope: FinooScope,
  apply: boolean,
): Promise<MembershipRepairResult> {
  const result: MembershipRepairResult = {
    batchesProcessed: 0,
    usersScanned: 0,
    membershipsCreated: 0,
    linksAdopted: 0,
    linksCreated: 0,
    attributionsLinked: 0,
  }
  const role = await loadAffiliateRole(em, scope.tenantId)
  if (!role) return result
  let offset = 0
  while (true) {
    const assignments = await findWithDecryption(
      em,
      CustomerUserRole,
      { role: role.id, deletedAt: null },
      {
        populate: ['user'],
        orderBy: { id: 'ASC' },
        limit: FINOO_MEMBERSHIP_REPAIR_BATCH_SIZE,
        offset,
      },
      scope,
    )
    if (assignments.length === 0) break
    result.batchesProcessed += 1
    const users = assignments
      .map((assignment) => assignment.user)
      .filter((user) => user.tenantId === scope.tenantId && user.organizationId === scope.organizationId && user.isActive && !user.deletedAt)
    result.usersScanned += users.length
    for (const user of users) {
      let affiliate = await findOneWithDecryption(
        em,
        FinooAffiliate,
        {
          ...scope,
          deletedAt: null,
          $or: [
            { customerUserId: user.id },
            { emailHash: { $in: lookupHashCandidates(user.email) } },
          ],
        },
        undefined,
        scope,
      )
      const links = await findWithDecryption(
        em,
        FinooAffiliateLink,
        { ...scope, affiliateUserId: user.id, isActive: true, deletedAt: null },
        { orderBy: { createdAt: 'ASC' }, limit: 2 },
        scope,
      )
      let primaryLink = affiliate?.primaryLinkId
        ? links.find((link) => link.id === affiliate?.primaryLinkId) ?? null
        : null
      const canAdopt = !affiliate
        ? links.length === 1 && !await findOneWithDecryption(em, FinooAffiliate, { code: links[0].code, deletedAt: null }, undefined, {})
        : links.length === 1 && links[0].code === affiliate.code
      if (!primaryLink && canAdopt) {
        result.linksAdopted += 1
        primaryLink = links[0]
      }
      const unlinkedCount = await em.count(
        FinooDealAttribution,
        { ...scope, affiliateUserId: user.id, affiliateId: null, deletedAt: null },
      )
      result.attributionsLinked += unlinkedCount
      if (!affiliate) result.membershipsCreated += 1
      if (!primaryLink) result.linksCreated += 1
      if (!apply) continue

      const normalizedEmail = normalizeAffiliateEmail(user.email)
      if (!affiliate && !primaryLink) {
        const created = await withReservedAffiliateCode(em, async (transactionalEm, code) => {
          const membership = transactionalEm.create(FinooAffiliate, {
            ...scope,
            customerUserId: user.id,
            email: normalizedEmail,
            emailHash: hashForLookup(normalizedEmail),
            code,
            isActive: true,
          })
          transactionalEm.persist(membership)
          const link = transactionalEm.create(FinooAffiliateLink, {
            ...scope,
            affiliateId: membership.id,
            affiliateUserId: user.id,
            code,
            label: 'Primary affiliate link',
            destinationUrl: resolveDefaultAffiliateDestination(),
            isActive: true,
          })
          transactionalEm.persist(link)
          membership.primaryLinkId = link.id
          await transactionalEm.flush()
          return { membership, link }
        })
        affiliate = created.membership
        primaryLink = created.link
      } else {
        if (!affiliate && primaryLink) {
          affiliate = em.create(FinooAffiliate, {
            ...scope,
            customerUserId: user.id,
            email: normalizedEmail,
            emailHash: hashForLookup(normalizedEmail),
            code: primaryLink.code,
            primaryLinkId: primaryLink.id,
            isActive: true,
          })
          em.persist(affiliate)
        }
        if (affiliate && !primaryLink) {
          primaryLink = em.create(FinooAffiliateLink, {
            ...scope,
            affiliateId: affiliate.id,
            affiliateUserId: user.id,
            code: affiliate.code,
            label: 'Primary affiliate link',
            destinationUrl: resolveDefaultAffiliateDestination(),
            isActive: true,
          })
          em.persist(primaryLink)
        }
      }
      if (!affiliate) throw new Error('[internal] Affiliate membership repair did not resolve a membership')
      affiliate.customerUserId = user.id
      affiliate.isActive = true
      if (primaryLink) {
        primaryLink.affiliateId = affiliate.id
        affiliate.primaryLinkId = primaryLink.id
      }
      await em.nativeUpdate(
        FinooDealAttribution,
        { ...scope, affiliateUserId: user.id, affiliateId: null, deletedAt: null },
        { affiliateId: affiliate.id },
      )
      await em.flush()
    }
    offset += assignments.length
    if (assignments.length < FINOO_MEMBERSHIP_REPAIR_BATCH_SIZE) break
  }
  return result
}
