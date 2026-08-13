import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { metadata as payoutsMetadata } from '../../frontend/[orgSlug]/portal/affiliate/payouts/page.meta'
import { metadata as profileMetadata } from '../../frontend/[orgSlug]/portal/affiliate/profile/page.meta'

describe('Phase 4 UI boundaries', () => {
  it('keeps client islands outside page auto-discovery roots and disables unsupported projected sorting', () => {
    const profilePage = readFileSync(resolve(process.cwd(), 'src/modules/finoo_affiliates/frontend/[orgSlug]/portal/affiliate/profile/page.tsx'), 'utf8')
    const leads = readFileSync(resolve(process.cwd(), 'src/modules/finoo_affiliates/frontend/[orgSlug]/portal/affiliate/leads/page.tsx'), 'utf8')
    expect(profilePage).not.toContain('use client')
    expect(leads).toMatch(/accessorKey: 'affiliateProgramStatus',[\s\S]*?enableSorting: false/)
    expect(leads).toMatch(/accessorKey: 'commissionAmount',[\s\S]*?enableSorting: false/)
  })

  it('publishes affiliate payouts and profile in the portal navigation', () => {
    expect(payoutsMetadata).toMatchObject({
      requireCustomerAuth: true,
      requireCustomerFeatures: ['portal.finoo_affiliates.view'],
      nav: {
        labelKey: 'finooAffiliates.payouts.title',
        group: 'main',
        order: 30,
      },
    })
    expect(profileMetadata).toMatchObject({
      requireCustomerAuth: true,
      requireCustomerFeatures: ['portal.finoo_affiliates.view'],
      nav: {
        labelKey: 'finooAffiliates.profile.nav',
        group: 'account',
        order: 40,
      },
    })
  })
})
