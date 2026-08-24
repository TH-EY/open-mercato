import type { ModuleInfo } from '@open-mercato/shared/modules/registry'

export const metadata: ModuleInfo = {
  name: 'finoo_identities',
  title: 'FINOO Identity Data',
  version: '0.1.0',
  description: 'Restricted PESEL and identity-document data for FINOO.',
  author: 'THEY.dev',
  license: 'UNLICENSED',
  requires: ['auth', 'customers', 'entities'],
}
