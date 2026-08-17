import type { SearchBuildContext, SearchModuleConfig, SearchResultPresenter } from '@open-mercato/shared/modules/search'

function readString(record: Record<string, unknown>, snakeCaseKey: string, camelCaseKey: string): string | null {
  const value = record[snakeCaseKey] ?? record[camelCaseKey]
  return typeof value === 'string' && value.length > 0 ? value : null
}

export const searchConfig: SearchModuleConfig = {
  entities: [
    {
      entityId: 'finoo_intermediaries:finoo_intermediary',
      enabled: true,
      priority: 7,
      strategies: ['fulltext', 'tokens'],
      fieldPolicy: {
        searchable: ['first_name', 'last_name'],
        hashOnly: ['email'],
        excluded: [
          'email_hash',
          'invitation_id',
          'invitation_expires_at',
          'last_email_kind',
          'last_email_status',
          'last_email_attempt_at',
          'last_email_delivered_at',
          'last_email_error_code',
        ],
      },
      formatResult: (ctx: SearchBuildContext): SearchResultPresenter => {
        const firstName = readString(ctx.record, 'first_name', 'firstName')
        const lastName = readString(ctx.record, 'last_name', 'lastName')
        return {
          title: [firstName, lastName].filter(Boolean).join(' ') || String(ctx.record.id),
          icon: 'user-round',
        }
      },
      resolveUrl: () => '/backend/finoo-intermediaries/intermediaries',
    },
  ],
}

export const config = searchConfig
export default searchConfig
