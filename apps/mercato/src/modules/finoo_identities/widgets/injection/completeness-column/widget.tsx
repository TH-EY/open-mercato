'use client'

import type { InjectionColumnWidget } from '@open-mercato/shared/modules/widgets/injection'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { StatusBadge } from '@open-mercato/ui/primitives/status-badge'

function CompletenessCell({ getValue }: { getValue: () => unknown }) {
  const t = useT()
  const complete = getValue() === true
  return (
    <StatusBadge variant={complete ? 'success' : 'warning'} dot>
      {t(`finoo_identities.aggregate.${complete ? 'complete' : 'incomplete'}`)}
    </StatusBadge>
  )
}

const widget: InjectionColumnWidget = {
  metadata: {
    id: 'finoo_identities.injection.completeness-column',
    priority: 20,
    requiredModules: ['customers'],
  },
  columns: [{
    id: 'finoo_identity_complete',
    headerKey: 'finoo_identities.identity.column',
    header: 'finoo_identities.identity.column',
    accessorKey: '_finooIdentities.isComplete',
    sortable: false,
    cell: CompletenessCell,
  }],
}

export default widget
