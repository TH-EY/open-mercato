import type { PageMetadata } from '@open-mercato/shared/modules/registry'

export const metadata: PageMetadata = {
  requireCustomerAuth: true,
  requireCustomerFeatures: ['portal.orders.view'],
  titleKey: 'sales.portal.orders.title',
  title: 'Orders',
  nav: {
    label: 'Orders',
    labelKey: 'sales.portal.orders.nav',
    group: 'main',
    order: 20,
  },
}

export default metadata
