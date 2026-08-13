import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('affiliate transaction transition route contract', () => {
  it('is feature gated and runs mutation guards before the command', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/modules/finoo_affiliates/api/transactions/[id]/transition/route.ts'), 'utf8')
    expect(source).toContain("requireFeatures: ['finoo_affiliates.manage']")
    expect(source).toContain('runRouteMutationGuards')
    expect(source.indexOf('runRouteMutationGuards({')).toBeLessThan(source.indexOf("commandBus') as CommandBus"))
    expect(source).toContain("'finoo_affiliates.transaction.transition'")
  })
})
