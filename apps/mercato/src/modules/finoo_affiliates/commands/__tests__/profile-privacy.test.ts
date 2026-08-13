import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('affiliate profile privacy contract', () => {
  it('skips ActionLog and keeps bank values out of the profile event payload', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/modules/finoo_affiliates/commands/profile.ts'), 'utf8')
    expect(source).toContain("return { skipLog: true }")
    const eventPayload = source.slice(source.indexOf("emitFinooAffiliateEvent('finoo_affiliates.affiliate.profile_updated'"))
    expect(eventPayload.slice(0, eventPayload.indexOf("}, { persistent: true }"))).not.toContain('accountHolderName')
    expect(eventPayload.slice(0, eventPayload.indexOf("}, { persistent: true }"))).not.toContain('accountNumber')
  })
})
