import type { PageRouteMiddleware } from '@open-mercato/shared/modules/middleware/page'

export const middleware: PageRouteMiddleware[] = [
  {
    id: 'finoo_affiliates.disable_portal_signup',
    mode: 'frontend',
    target: /^\/[^/]+\/portal\/signup$/,
    run: ({ pathname }) => ({
      action: 'redirect',
      location: pathname.replace(/\/signup$/, '/login'),
    }),
  },
]
