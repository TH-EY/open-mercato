import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('affiliate membership command scope', () => {
  it('passes only tenant and organization identifiers to membership services', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/modules/finoo_affiliates/commands/affiliate-memberships.ts'), 'utf8')
    expect(source).toContain('const scope = { tenantId: input.tenantId, organizationId: input.organizationId }')
    expect(source).not.toContain('if (ctx.systemActor) return input')
  })
})
