import type { PageMetadata } from '@open-mercato/shared/modules/registry'

export const metadata: PageMetadata = {
  requireCustomerAuth: true,
  requireCustomerFeatures: ['portal.finoo_affiliates.view'],
  title: 'Affiliate profile',
  titleKey: 'finooAffiliates.profile.title',
  nav: {
    label: 'Affiliate profile',
    labelKey: 'finooAffiliates.profile.nav',
    group: 'account',
    order: 40,
    icon: 'user',
  },
}

export default metadata
