import type { PageMetadata } from '@open-mercato/shared/modules/registry'

export const metadata: PageMetadata = {
  requireCustomerAuth: true,
  requireCustomerFeatures: ['portal.finoo_affiliates.view'],
  title: 'Leads',
  titleKey: 'finooAffiliates.portal.leads.title',
  nav: {
    label: 'Leads',
    labelKey: 'finooAffiliates.portal.leads.nav',
    group: 'main',
    order: 20,
  },
}

export default metadata
