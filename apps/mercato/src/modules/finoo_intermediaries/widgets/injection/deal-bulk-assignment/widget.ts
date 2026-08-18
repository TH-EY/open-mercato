import type { InjectionBulkActionWidget } from '@open-mercato/shared/modules/widgets/injection'

type BulkActionContext = {
  navigate?: (href: string) => void
  translate?: (key: string, fallback: string, values?: Record<string, unknown>) => string
}

function readRowId(row: unknown): string | null {
  if (!row || typeof row !== 'object') return null
  const id = (row as Record<string, unknown>).id
  return typeof id === 'string' && id.length > 0 ? id : null
}

const widget: InjectionBulkActionWidget = {
  metadata: {
    id: 'finoo_intermediaries.injection.deal-bulk-assignment',
    priority: 20,
    features: ['finoo_intermediaries.manage'],
  },
  bulkActions: [{
    id: 'finoo_intermediaries.assign-selected-deals',
    label: 'finoo_intermediaries.bulk.action',
    requiresSelection: true,
    onExecute: async (selectedRows, rawContext) => {
      const context = rawContext as BulkActionContext
      const dealIds = [...new Set(selectedRows.flatMap((row) => {
        const id = readRowId(row)
        return id ? [id] : []
      }))].sort()
      if (dealIds.length < 1 || dealIds.length > 100) {
        return {
          ok: false,
          message: context.translate?.(
            'finoo_intermediaries.bulk.selectionLimit',
            'Select between 1 and 100 Deals.',
          ) ?? 'Select between 1 and 100 Deals.',
        }
      }
      context.navigate?.(`/backend/finoo-intermediaries/bulk-assignments?dealIds=${encodeURIComponent(dealIds.join(','))}`)
      return { ok: false }
    },
  }],
}

export default widget
