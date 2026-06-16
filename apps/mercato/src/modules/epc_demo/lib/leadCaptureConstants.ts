export const EPC_LEAD_SOURCE = 'web form'

export const EPC_SERVICE_NEEDED_FIELD_KEY = 'service_needed'
export const EPC_PROJECT_TYPE_FIELD_KEY = 'project_type'

export const EPC_SERVICE_NEEDED_DICTIONARY_ID = 'c5f330a0-e81d-4f77-840c-e5c74bf1bff5'
export const EPC_PROJECT_TYPE_DICTIONARY_ID = '134e834d-3cd7-4404-ad3e-258732747641'

export const EPC_SERVICE_NEEDED_OPTIONS = [
  { value: 'heat_pumps', label: 'Heat Pumps' },
  { value: 'solar_panels', label: 'Solar Panels' },
  { value: 'battery_storage', label: 'Battery Storage' },
  { value: 'underfloor_heating', label: 'Underfloor Heating' },
  { value: 'ventilation_mvhr', label: 'Ventilation (MVHR)' },
  { value: 'servicing_repairs', label: 'Servicing & Repairs' },
  { value: 'other', label: 'Other' },
] as const

export const EPC_PROJECT_TYPE_OPTIONS = [
  { value: 'retrofit', label: 'Retrofit' },
  { value: 'renovation', label: 'Renovation' },
  { value: 'self_build', label: 'Self build' },
  { value: 'multipilot_development', label: 'Multipilot development' },
  { value: 'commercial', label: 'Commercial' },
  { value: 'other', label: 'Other' },
] as const

export const EPC_SERVICE_NEEDED_VALUES = EPC_SERVICE_NEEDED_OPTIONS.map((option) => option.value) as [
  typeof EPC_SERVICE_NEEDED_OPTIONS[number]['value'],
  ...Array<typeof EPC_SERVICE_NEEDED_OPTIONS[number]['value']>,
]

export const EPC_PROJECT_TYPE_VALUES = EPC_PROJECT_TYPE_OPTIONS.map((option) => option.value) as [
  typeof EPC_PROJECT_TYPE_OPTIONS[number]['value'],
  ...Array<typeof EPC_PROJECT_TYPE_OPTIONS[number]['value']>,
]
