import type { ModuleInfo } from '@open-mercato/shared/modules/registry'

export const metadata: ModuleInfo = {
  name: 'finoo_intermediaries',
  title: 'FINOO Intermediaries',
  version: '0.1.0',
  description: 'Private FINOO intermediary assignment and portal workflow.',
  author: 'THEY.dev',
  license: 'UNLICENSED',
  requires: ['customers', 'customer_accounts'],
}
