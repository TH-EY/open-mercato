import type { ModuleInfo } from '@open-mercato/shared/modules/registry'

export const metadata: ModuleInfo = {
  name: 'finoo_customer_retention',
  title: 'Finoo Customer Retention',
  version: '0.1.0',
  description: 'Private Finoo customer data-retention policy and projection.',
  author: 'THEY.dev',
  license: 'UNLICENSED',
  requires: [
    'audit_logs',
    'customers',
    'customer_accounts',
    'directory',
    'entities',
    'events',
    'finoo_identities',
    'progress',
    'scheduler',
  ],
}
