import type { CustomEntitySpec, CustomFieldDefinition } from '@open-mercato/shared/modules/entities'

export const FINOO_CUSTOMER_RETENTION_FIELDS = [
  {
    key: 'finoo_retention_status',
    kind: 'select',
    label: 'Retention status',
    options: [
      { value: 'active', label: 'Active' },
      { value: 'expired', label: 'Expired' },
      { value: 'excluded', label: 'Not applicable' },
    ],
    filterable: true,
    indexed: true,
    listVisible: true,
    formEditable: false,
  },
  {
    key: 'finoo_retention_expires_at',
    kind: 'datetime',
    label: 'Retention expiry',
    filterable: true,
    indexed: true,
    listVisible: true,
    formEditable: false,
  },
] satisfies CustomFieldDefinition[]

export const entities: CustomEntitySpec[] = [
  {
    id: 'customers:customer_person_profile',
    fields: FINOO_CUSTOMER_RETENTION_FIELDS,
  },
]

export default entities
