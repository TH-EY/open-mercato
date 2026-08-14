import type { PageMetadata } from '@open-mercato/shared/modules/registry'

export const metadata: PageMetadata = {
  requireCustomerAuth: true,
  requireCustomerFeatures: ['portal.finoo_intermediaries.view'],
  titleKey: 'finoo_intermediaries.portal.deal.title',
  title: 'Deal details',
}

export default metadata
