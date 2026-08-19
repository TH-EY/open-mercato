import type { ModuleEncryptionMap } from '@open-mercato/shared/modules/encryption'

export const defaultEncryptionMaps: ModuleEncryptionMap[] = [{
  entityId: 'finoo_applications:finoo_application_intake',
  fields: [{ field: 'payload_json' }],
}]

export default defaultEncryptionMaps
