import type { ModuleEncryptionMap } from '@open-mercato/shared/modules/encryption'

export const defaultEncryptionMaps: ModuleEncryptionMap[] = [
  {
    entityId: 'finoo_identities:finoo_person_identity',
    fields: [
      { field: 'pesel' },
      { field: 'document_type' },
      { field: 'issuing_country_code' },
      { field: 'document_number' },
      { field: 'issued_on' },
      { field: 'expires_on' },
    ],
  },
  {
    entityId: 'finoo_identities:finoo_identity_import_conflict',
    fields: [
      { field: 'candidate_pesel' },
      { field: 'candidate_document_type' },
      { field: 'candidate_issuing_country_code' },
      { field: 'candidate_document_number' },
      { field: 'candidate_issued_on' },
      { field: 'candidate_expires_on' },
    ],
  },
]

export default defaultEncryptionMaps
