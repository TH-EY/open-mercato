import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('Phase 4 UI boundaries', () => {
  it('keeps client islands outside page auto-discovery roots and disables unsupported projected sorting', () => {
    const profilePage = readFileSync(resolve(process.cwd(), 'src/modules/finoo_affiliates/frontend/[orgSlug]/portal/affiliate/profile/page.tsx'), 'utf8')
    const leads = readFileSync(resolve(process.cwd(), 'src/modules/finoo_affiliates/frontend/[orgSlug]/portal/affiliate/leads/page.tsx'), 'utf8')
    expect(profilePage).not.toContain('use client')
    expect(leads).toMatch(/accessorKey: 'affiliateProgramStatus',[\s\S]*?enableSorting: false/)
    expect(leads).toMatch(/accessorKey: 'commissionAmount',[\s\S]*?enableSorting: false/)
  })
})
