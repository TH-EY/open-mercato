import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const moduleRoot = resolve(__dirname, '..')
const affiliateRoot = resolve(moduleRoot, '..', 'finoo_affiliates')

function source(root: string, relativePath: string): string {
  return readFileSync(resolve(root, relativePath), 'utf8')
}

describe('FINOO visible mutation error contract', () => {
  it.each([
    ['affiliate transaction actions', affiliateRoot, 'components/transactions.client.tsx', ['surfaceRecordConflict', 'payoutErrorMessage', "flash("]],
    ['affiliate link actions', affiliateRoot, 'backend/finoo-affiliates/links/page.tsx', ['surfaceRecordConflict', "flash("]],
    ['affiliate invitation', affiliateRoot, 'components/affiliates/invite-affiliate-dialog.client.tsx', ['setErrorStage']]],
  )('%s retains a user-visible failure surface', (_name, root, file, expected) => {
    const content = source(root, file)
    for (const token of expected) expect(content).toContain(token)
  })

  it.each([
    ['affiliate commission settings', affiliateRoot, 'components/affiliates/commission-settings-dialog.client.tsx'],
    ['affiliate Deal attribution', affiliateRoot, 'widgets/injection/deal-attribution/widget.client.tsx'],
    ['affiliate payout confirmation', affiliateRoot, 'components/payout-preview-dialog.client.tsx'],
    ['intermediary Deal assignment', moduleRoot, 'widgets/injection/deal-assignment/widget.client.tsx'],
    ['intermediary portal Deal actions', moduleRoot, 'frontend/[orgSlug]/portal/intermediary/deals/[id]/page.client.tsx'],
    ['intermediary bulk assignment', moduleRoot, 'components/bulk-assignments/bulk-assignment.client.tsx'],
  ])('%s catches rejected mutations and renders an inline error or flash', (_name, root, file) => {
    const content = source(root, file)
    expect(content).toContain('catch')
    expect(content).toMatch(/setError\(|flash\(/)
  })

  it('affiliate profile save catches conflicts and has a localized fallback flash', () => {
    const content = source(affiliateRoot, 'components/portal-profile.client.tsx')
    expect(content).toContain('surfaceRecordConflict')
    expect(content).toContain("flash(t('finooAffiliates.profile.saveError'")
  })

  it('intermediary directory row actions catch conflicts and use a localized fallback flash', () => {
    const content = source(moduleRoot, 'components/intermediaries/intermediary-row-actions.client.tsx')
    expect(content).toContain('surfaceRecordConflict')
    expect(content).toContain("finoo_intermediaries.directory.errors.action")
  })
})
