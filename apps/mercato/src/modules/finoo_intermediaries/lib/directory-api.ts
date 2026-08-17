import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import { z } from 'zod'
import type { SearchService } from '@open-mercato/search'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { lookupHashCandidates } from '@open-mercato/shared/lib/encryption/aes'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import type { EffectiveIntermediaryStatus } from './domain'
import { resolveEffectiveIntermediaryStatus } from './domain'
import { decodeCursor, encodeCursor } from './pagination'
import { FinooIntermediary } from '../data/entities'
import type { DirectoryCommandResult } from '../commands/directory'

const DIRECTORY_ENTITY_ID = 'finoo_intermediaries:finoo_intermediary'
const SEARCH_RESULT_LIMIT = 1_000

export const directoryQuerySchema = z.object({
  search: z.string().trim().min(1).max(320).optional(),
  status: z.enum(['delivery_failed', 'invited', 'expired', 'active', 'inactive']).optional(),
  cursor: z.string().trim().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
}).strict()

export const directoryItemSchema = z.object({
  id: z.string().uuid(),
  firstName: z.string(),
  lastName: z.string(),
  email: z.string().email(),
  status: z.enum(['delivery_failed', 'invited', 'expired', 'active', 'inactive']),
  hasLinkedAccount: z.boolean(),
  relatedDeals: z.number().int().nonnegative(),
  invitationExpiresAt: z.string().datetime().nullable(),
  lastEmailStatus: z.enum(['pending', 'delivered', 'failed']).nullable(),
  lastEmailErrorCode: z.string().nullable(),
  updatedAt: z.string().datetime(),
})

export const directoryResponseSchema = z.object({
  items: z.array(directoryItemSchema),
  nextCursor: z.string().nullable(),
})

export type IntermediaryDirectoryItem = z.infer<typeof directoryItemSchema>

type DirectoryScope = { tenantId: string; organizationId: string }
type AssignmentCountRow = { intermediary_customer_user_id: string; count: string | number | bigint }

function statusFilter(
  status: EffectiveIntermediaryStatus | undefined,
  now: Date,
): Record<string, unknown> {
  if (status === 'expired') {
    return { lifecycleState: 'invited', invitationExpiresAt: { $lte: now } }
  }
  if (status === 'invited') {
    return {
      lifecycleState: 'invited',
      $or: [
        { invitationExpiresAt: null },
        { invitationExpiresAt: { $gt: now } },
      ],
    }
  }
  return status ? { lifecycleState: status } : {}
}

async function resolveSearchIds(
  searchService: SearchService | undefined,
  search: string,
  scope: DirectoryScope,
): Promise<string[]> {
  const normalized = search.trim().toLowerCase()
  if (z.string().email().safeParse(normalized).success) return []
  if (!searchService) return []
  const results = await searchService.search(search, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    entityTypes: [DIRECTORY_ENTITY_ID],
    strategies: ['fulltext', 'tokens'],
    limit: SEARCH_RESULT_LIMIT,
  })
  return results
    .filter((result) => result.entityId === DIRECTORY_ENTITY_ID)
    .map((result) => result.recordId)
}

async function loadRelatedDealCounts(
  em: EntityManager,
  scope: DirectoryScope,
  customerUserIds: string[],
): Promise<Map<string, number>> {
  if (customerUserIds.length === 0) return new Map()
  const rows = await em.getKysely<{
    finoo_intermediary_assignments: {
      intermediary_customer_user_id: string
      tenant_id: string
      organization_id: string
      deleted_at: Date | null
    }
  }>()
    .selectFrom('finoo_intermediary_assignments')
    .select('intermediary_customer_user_id')
    .select((expression) => expression.fn.countAll().as('count'))
    .where('tenant_id', '=', scope.tenantId)
    .where('organization_id', '=', scope.organizationId)
    .where('deleted_at', 'is', null)
    .where('intermediary_customer_user_id', 'in', customerUserIds)
    .groupBy('intermediary_customer_user_id')
    .execute() as AssignmentCountRow[]
  return new Map(rows.map((row) => [row.intermediary_customer_user_id, Number(row.count)]))
}

function safeEmailErrorCode(value: string | null | undefined): string | null {
  return value === 'email_delivery_failed' ? value : null
}

export function serializeDirectoryItem(
  intermediary: FinooIntermediary,
  relatedDeals: number,
  now = new Date(),
): IntermediaryDirectoryItem {
  return {
    id: intermediary.id,
    firstName: intermediary.firstName,
    lastName: intermediary.lastName,
    email: intermediary.email,
    status: resolveEffectiveIntermediaryStatus(intermediary, now),
    hasLinkedAccount: Boolean(intermediary.customerUserId),
    relatedDeals,
    invitationExpiresAt: intermediary.invitationExpiresAt?.toISOString() ?? null,
    lastEmailStatus: intermediary.lastEmailStatus ?? null,
    lastEmailErrorCode: safeEmailErrorCode(intermediary.lastEmailErrorCode),
    updatedAt: intermediary.updatedAt.toISOString(),
  }
}

export async function loadDirectoryItem(
  em: EntityManager,
  intermediary: FinooIntermediary,
  scope: DirectoryScope,
): Promise<IntermediaryDirectoryItem> {
  const counts = await loadRelatedDealCounts(
    em,
    scope,
    intermediary.customerUserId ? [intermediary.customerUserId] : [],
  )
  return serializeDirectoryItem(
    intermediary,
    intermediary.customerUserId ? counts.get(intermediary.customerUserId) ?? 0 : 0,
  )
}

export async function loadDirectoryPage(input: {
  em: EntityManager
  searchService?: SearchService
  scope: DirectoryScope
  query: z.infer<typeof directoryQuerySchema>
  now?: Date
}): Promise<z.infer<typeof directoryResponseSchema>> {
  const now = input.now ?? new Date()
  const cursor = decodeCursor(input.query.cursor)
  if (input.query.cursor && !cursor) {
    throw new CrudHttpError(400, { error: 'Invalid cursor' })
  }

  const where: Record<string, unknown> = {
    tenantId: input.scope.tenantId,
    organizationId: input.scope.organizationId,
    deletedAt: null,
    ...statusFilter(input.query.status, now),
  }
  if (cursor) {
    where.$and = [{
      $or: [
        { updatedAt: { $lt: new Date(cursor.timestamp) } },
        { updatedAt: new Date(cursor.timestamp), id: { $lt: cursor.id } },
      ],
    }]
  }
  if (input.query.search) {
    const normalized = input.query.search.trim().toLowerCase()
    if (z.string().email().safeParse(normalized).success) {
      where.emailHash = { $in: lookupHashCandidates(normalized) }
    } else {
      const ids = await resolveSearchIds(input.searchService, input.query.search, input.scope)
      if (ids.length === 0) return { items: [], nextCursor: null }
      where.id = { $in: ids }
    }
  }

  const rows = await findWithDecryption(
    input.em,
    FinooIntermediary,
    where as FilterQuery<FinooIntermediary>,
    { orderBy: { updatedAt: 'desc', id: 'desc' }, limit: input.query.pageSize + 1 },
    input.scope,
  )
  const hasMore = rows.length > input.query.pageSize
  const pageRows = hasMore ? rows.slice(0, input.query.pageSize) : rows
  const userIds = pageRows.flatMap((row) => row.customerUserId ? [row.customerUserId] : [])
  const counts = await loadRelatedDealCounts(input.em, input.scope, userIds)
  const items = pageRows.map((row) => serializeDirectoryItem(
    row,
    row.customerUserId ? counts.get(row.customerUserId) ?? 0 : 0,
    now,
  ))
  const last = pageRows.at(-1)
  return {
    items,
    nextCursor: hasMore && last
      ? encodeCursor({ timestamp: last.updatedAt.toISOString(), id: last.id })
      : null,
  }
}

export async function serializeDirectoryCommandResult(
  em: EntityManager,
  result: DirectoryCommandResult,
  scope: DirectoryScope,
) {
  return {
    item: await loadDirectoryItem(em, result.intermediary, scope),
    ...(result.requiresReactivation ? { requiresReactivation: true } : {}),
    ...(result.warningCode ? { warningCode: result.warningCode } : {}),
  }
}
