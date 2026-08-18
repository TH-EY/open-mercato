export const metadata = {
  requireAuth: true,
  requireFeatures: ['finoo_intermediaries.manage'],
  pageTitle: 'Assign selected Deals',
  pageTitleKey: 'finoo_intermediaries.bulk.title',
  navHidden: true,
  breadcrumb: [
    { label: 'Deals', labelKey: 'customers.nav.deals', href: '/backend/customers/deals' },
    { label: 'Assign selected Deals', labelKey: 'finoo_intermediaries.bulk.title' },
  ],
}

export default metadata
