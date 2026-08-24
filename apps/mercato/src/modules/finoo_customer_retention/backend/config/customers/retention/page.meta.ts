export const metadata = {
  requireAuth: true,
  requireFeatures: ['customers.settings.manage'],
  pageTitle: 'Customer data retention',
  pageTitleKey: 'finooCustomerRetention.settings.navTitle',
  pageGroup: 'Module Configs',
  pageGroupKey: 'settings.sections.moduleConfigs',
  pageOrder: 6,
  pageContext: 'settings' as const,
  icon: 'clock',
  breadcrumb: [
    {
      label: 'Customer data retention',
      labelKey: 'finooCustomerRetention.settings.navTitle',
    },
  ],
} as const
