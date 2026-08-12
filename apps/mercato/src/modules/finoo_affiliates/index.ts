import type { ModuleInfo } from '@open-mercato/shared/modules/registry'

export const metadata: ModuleInfo = {
  name: 'finoo_affiliates',
  title: 'Finoo Affiliates',
  version: '0.1.0',
  description: 'Finoo affiliate links, attribution, commissions, and portal reporting.',
  author: 'THEY.dev',
  license: 'UNLICENSED',
  requires: ['customers', 'customer_accounts', 'portal', 'dictionaries', 'events', 'scheduler'],
}
