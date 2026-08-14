import type { PageMetadata } from '@open-mercato/shared/modules/registry'

export const metadata: PageMetadata = {
  requireCustomerAuth: true,
  requireCustomerFeatures: ['portal.finoo_intermediaries.view'],
  titleKey: 'finoo_intermediaries.portal.deals.title',
  title: 'Assigned deals',
  nav: {
    label: 'Assigned deals',
    labelKey: 'finoo_intermediaries.portal.nav.deals',
    group: 'main',
    order: 30,
  },
}

export default metadata
