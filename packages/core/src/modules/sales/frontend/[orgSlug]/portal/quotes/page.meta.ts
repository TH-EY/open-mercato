import type { PageMetadata } from '@open-mercato/shared/modules/registry'

export const metadata: PageMetadata = {
  requireCustomerAuth: true,
  requireCustomerFeatures: ['portal.quotes.view'],
  titleKey: 'sales.portal.quotes.title',
  title: 'Quotes',
  nav: {
    label: 'Quotes',
    labelKey: 'sales.portal.quotes.nav',
    group: 'main',
    order: 30,
  },
}

export default metadata
