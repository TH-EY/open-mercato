import type { EntityManager } from '@mikro-orm/postgresql'

type RetentionAffiliateDatabase = {
  finoo_affiliates: RetentionAffiliateDatabaseRow & {
    tenant_id: string
    organization_id: string
  }
}

export type FinooAffiliateRetentionFacts = {
  activeCustomerUserIds: string[]
  latestDeletedAtByCustomerUserId: Map<string, Date>
}

export type FinooAffiliateRetentionEligibilityProvider = {
  findFacts(input: {
    tenantId: string
    organizationId: string
    customerUserIds: string[]
    em?: EntityManager
  }): Promise<FinooAffiliateRetentionFacts>
}

type RetentionAffiliateRow = {
  customerUserId: string | null
  deletedAt: Date | string | null
}

type RetentionAffiliateDatabaseRow = {
  customer_user_id: string | null
  deleted_at: Date | string | null
}

export function summarizeAffiliateRetentionRows(
  rows: RetentionAffiliateRow[],
): FinooAffiliateRetentionFacts {
  const activeCustomerUserIds = new Set<string>()
  const latestDeletedAtByCustomerUserId = new Map<string, Date>()

  for (const row of rows) {
    if (!row.customerUserId) continue
    const deletedAt = row.deletedAt instanceof Date
      ? row.deletedAt
      : row.deletedAt
        ? new Date(row.deletedAt)
        : null
    if (!deletedAt) {
      activeCustomerUserIds.add(row.customerUserId)
      continue
    }
    const previous = latestDeletedAtByCustomerUserId.get(row.customerUserId)
    if (!previous || deletedAt > previous) {
      latestDeletedAtByCustomerUserId.set(row.customerUserId, deletedAt)
    }
  }

  return {
    activeCustomerUserIds: [...activeCustomerUserIds],
    latestDeletedAtByCustomerUserId,
  }
}

export function createFinooAffiliateRetentionEligibilityProvider(
  em: EntityManager,
): FinooAffiliateRetentionEligibilityProvider {
  return {
    async findFacts(input) {
      const customerUserIds = [...new Set(input.customerUserIds)]
      if (customerUserIds.length === 0) {
        return {
          activeCustomerUserIds: [],
          latestDeletedAtByCustomerUserId: new Map(),
        }
      }

      const rows = await (input.em ?? em).getKysely<RetentionAffiliateDatabase>()
        .selectFrom('finoo_affiliates')
        .select(['customer_user_id', 'deleted_at'])
        .where('tenant_id', '=', input.tenantId)
        .where('organization_id', '=', input.organizationId)
        .where('customer_user_id', 'in', customerUserIds)
        .execute()

      return summarizeAffiliateRetentionRows(rows.map((row) => ({
        customerUserId: row.customer_user_id,
        deletedAt: row.deleted_at,
      })))
    },
  }
}
