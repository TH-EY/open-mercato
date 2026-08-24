import type { ApiInterceptor } from '@open-mercato/shared/lib/crud/api-interceptor'
import { isIdsParamProvided, parseIdsParam } from '@open-mercato/shared/lib/crud/ids'
const MAX_CRUD_FILTER_IDS = 200
const EMPTY_RESULT_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff'

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function readCompleteness(value: unknown): boolean | null {
  const token = readString(value)
  if (token === 'true') return true
  if (token === 'false') return false
  return null
}

export const interceptors: ApiInterceptor[] = [
  {
    id: 'finoo_identities.people.completeness-filter',
    targetRoute: 'customers/people',
    methods: ['GET'],
    priority: 70,
    async before(request, context) {
      const isComplete = readCompleteness(request.query?.finooIdentityComplete)
      if (isComplete === null) return { ok: true }

      const idsParamProvided = isIdsParamProvided(request.query?.ids)
      const existingIds = parseIdsParam(request.query?.ids, MAX_CRUD_FILTER_IDS)
      if (idsParamProvided && existingIds.length === 0) {
        return {
          ok: true,
          query: {
            ...(request.query ?? {}),
            finooIdentityComplete: undefined,
            ids: EMPTY_RESULT_ID,
          },
        }
      }
      const idClause = existingIds?.length
        ? `and person.id in (${existingIds.map(() => '?').join(', ')})`
        : ''
      const matches = await context.em.getConnection().execute<Array<{ person_id: string }>>(
        `select person.id as person_id
         from customer_entities person
         left join finoo_person_identities identity
           on identity.tenant_id = person.tenant_id
          and identity.organization_id = person.organization_id
          and identity.person_id = person.id
          and identity.deleted_at is null
         where person.tenant_id = ?
           and person.organization_id = ?
           and person.kind = 'person'
           and person.deleted_at is null
           and coalesce(identity.is_complete, false) = ?
           ${idClause}
         limit ?`,
        [
          context.tenantId,
          context.organizationId,
          isComplete,
          ...existingIds,
          MAX_CRUD_FILTER_IDS + 1,
        ],
      )

      if (matches.length > MAX_CRUD_FILTER_IDS) {
        return {
          ok: false,
          statusCode: 422,
          message: 'identity_filter_too_broad',
        }
      }

      const ids = matches.map((entry) => entry.person_id)

      return {
        ok: true,
        query: {
          ...(request.query ?? {}),
          finooIdentityComplete: undefined,
          ids: ids.length > 0 ? ids.join(',') : EMPTY_RESULT_ID,
        },
      }
    },
  },
]

export default interceptors
