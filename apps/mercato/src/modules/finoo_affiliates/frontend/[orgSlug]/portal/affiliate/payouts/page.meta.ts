import type { PageMetadata } from '@open-mercato/shared/modules/registry'

export const metadata: PageMetadata = {
  requireCustomerAuth: true,
  requireCustomerFeatures: ['portal.finoo_affiliates.view'],
  title: 'Affiliate payouts',
  titleKey: 'finooAffiliates.payouts.title',
  nav: {
    label: 'Affiliate payouts',
    labelKey: 'finooAffiliates.payouts.title',
    group: 'main',
    order: 30,
    icon: 'banknote',
  },
}

export default metadata
