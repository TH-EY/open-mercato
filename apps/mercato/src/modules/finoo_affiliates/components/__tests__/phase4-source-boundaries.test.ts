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

  it('keeps affiliate-only Polish portal content free of unrelated English demo widgets', () => {
    const examplePortalWidgets = [
      'portal-quick-links',
      'portal-recent-activity',
      'portal-stats',
    ]
    for (const widget of examplePortalWidgets) {
      const source = readFileSync(
        resolve(process.cwd(), `src/modules/example/widgets/injection/${widget}/widget.ts`),
        'utf8',
      )
      expect(source).toContain("features: ['portal.orders.view']")
    }

    const polish = JSON.parse(
      readFileSync(resolve(process.cwd(), 'src/modules/finoo_affiliates/i18n/pl.json'), 'utf8'),
    ) as Record<string, string>
    const english = JSON.parse(
      readFileSync(resolve(process.cwd(), 'src/modules/finoo_affiliates/i18n/en.json'), 'utf8'),
    ) as Record<string, string>
    expect(polish['finooAffiliates.common.close']).toBe('Zamknij')
    expect(polish['finooAffiliates.payouts.confirmWarning']).toBe(
      'Potwierdź wyłącznie wtedy, gdy płatność została faktycznie wykonana.',
    )
    expect(polish['finooAffiliates.portal.dashboard.loadError']).toBe(
      'Nie udało się załadować danych panelu.',
    )
    expect(polish['finooAffiliates.portal.leads.landingPage']).toBe('Strona docelowa')
    expect(polish['finooAffiliates.portal.leads.initialReferrer']).toBe('Pierwsze źródło wejścia')

    const untranslatedPortalKeys = Object.keys(polish).filter(
      (key) => key.includes('.portal.') && polish[key] === english[key],
    )
    expect(untranslatedPortalKeys).toEqual([])
  })
})
