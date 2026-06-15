import type { ModuleInfo } from '@open-mercato/shared/modules/registry'

export const metadata: ModuleInfo = {
  name: 'epc_demo',
  title: 'EPC Demo Data',
  version: '0.1.0',
  description: 'Fork-only realistic EPC Improvements demo data for the customer portal.',
  author: 'TH-EY',
  license: 'UNLICENSED',
  requires: ['customers', 'customer_accounts', 'sales'],
}

