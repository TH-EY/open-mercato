import { describe, expect, it } from '@jest/globals'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('primary affiliate link mutation guard', () => {
  it('protects primary links from lifecycle and ownership mutations', () => {
    const source = readFileSync(resolve(
      process.cwd(),
      'src/modules/finoo_affiliates/commands/mutations.ts',
    ), 'utf8')

    expect(source).toContain("throw new CrudHttpError(409, { error: 'PRIMARY_AFFILIATE_LINK_IMMUTABLE' })")
    expect(source.match(/await rejectPrimaryLinkMutation\(em, link, scope\)/g)).toHaveLength(4)
    expect(source).toContain('input.affiliateUserId !== undefined || input.destinationUrl !== undefined || input.isActive !== undefined')
  })
})
