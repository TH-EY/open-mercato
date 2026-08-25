import type { EntityManager } from '@mikro-orm/postgresql'
import { sql } from 'kysely'
import type { FinooRetentionScope } from './projectionService'

export async function lockRetentionSubject(
  em: EntityManager,
  scope: FinooRetentionScope,
  customerEntityId: string,
): Promise<void> {
  const key = `${scope.tenantId}:${scope.organizationId}:${customerEntityId}`
  await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(em.getKysely())
}
