import type { ModuleInfo } from '@open-mercato/shared/modules/registry'

export const metadata: ModuleInfo = {
  name: 'finoo_applications',
  title: 'Finoo Applications',
  version: '0.1.0',
  description: 'Secure FINOO application-form ingestion and CRM projection.',
  author: 'THEY.dev',
  license: 'UNLICENSED',
  requires: ['customers', 'dictionaries', 'entities', 'integrations', 'scheduler'],
}
