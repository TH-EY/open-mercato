import type { IntegrationBundle, IntegrationDefinition } from '@open-mercato/shared/modules/integrations/types'

export const FINOO_APPLICATION_INTEGRATION_ID = 'finoo_application'

export const integration: IntegrationDefinition = {
  id: FINOO_APPLICATION_INTEGRATION_ID,
  title: 'FINOO application intake',
  description: 'Signed server-to-server intake from finoo.pl.',
  category: 'webhook',
  providerKey: FINOO_APPLICATION_INTEGRATION_ID,
  icon: 'webhook',
  package: 'finoo_applications',
  version: '1.0.0',
  author: 'THEY.dev',
  company: 'THEY.dev',
  license: 'UNLICENSED',
  defaultState: { isEnabled: false },
  credentials: { fields: [{ key: 'signingSecret', label: 'Signing secret', type: 'secret', required: true }] },
}

export const integrations: IntegrationDefinition[] = [integration]
export const bundles: IntegrationBundle[] = []
export const bundle: IntegrationBundle | undefined = undefined
