import type { ModuleEncryptionMap } from '@open-mercato/shared/modules/encryption'

export const defaultEncryptionMaps: ModuleEncryptionMap[] = [
  {
    entityId: 'finoo_intermediaries:finoo_intermediary_note',
    fields: [{ field: 'body' }],
  },
]

export default defaultEncryptionMaps
