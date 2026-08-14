import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('Finoo affiliate commission route contract', () => {
  const source = readFileSync(resolve(__dirname, '../route.ts'), 'utf8')

  it('requires manage access and runs mutation guards before the command bus', () => {
    expect(source).toContain("PATCH: { requireAuth: true, requireFeatures: ['finoo_affiliates.manage'] }")
    expect(source.indexOf('runRouteMutationGuards({')).toBeLessThan(source.indexOf("container.resolve('commandBus')"))
  })

  it('routes updates through optimistic-lock-aware command handling', () => {
    expect(source).toContain('finooAffiliateCommissionUpdateSchema')
    expect(source).toContain("'finoo_affiliates.affiliate.update_commission'")
    expect(source).toContain('isCrudHttpError(error)')
    expect(source).toContain('await guarded.runAfterSuccess()')
  })
})
