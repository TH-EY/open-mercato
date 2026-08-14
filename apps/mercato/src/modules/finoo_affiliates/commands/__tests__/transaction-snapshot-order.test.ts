import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('affiliate transaction pre-edit snapshot ordering', () => {
  it('runs transaction creation before staff attribution mutation and again after persistence', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/modules/finoo_affiliates/commands/mutations.ts'), 'utf8')
    const command = source.slice(source.indexOf('const upsertAttributionCommand'))
    const calls = [...command.matchAll(/commandBus\.execute\(/g)].map((match) => match.index ?? -1)
    expect(calls).toHaveLength(2)
    expect(calls[0]).toBeLessThan(command.indexOf('attribution.affiliateUserId = input.affiliateUserId'))
    expect(calls[1]).toBeGreaterThan(command.indexOf('await em.flush()'))
  })

  it('runs transaction creation before automatic attribution mutation and after persistence', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/modules/finoo_affiliates/lib/attributionSync.ts'), 'utf8')
    const preEdit = source.indexOf('if (attribution) await triggerTransactionCreation')
    const mutation = source.indexOf('attribution.deletedAt = null')
    const postWrite = source.lastIndexOf('await triggerTransactionCreation')
    expect(preEdit).toBeGreaterThan(0)
    expect(preEdit).toBeLessThan(mutation)
    expect(postWrite).toBeGreaterThan(source.indexOf('await em.flush()'))
  })

  it('runs transaction creation before Deal deletion with the deleted-Deal recovery flag', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/modules/finoo_affiliates/subscribers/deal-deleted.ts'), 'utf8')
    const creation = source.indexOf("commandBus.execute('finoo_affiliates.transaction.create'")
    const deletion = source.indexOf('attribution.deletedAt = new Date()')
    expect(creation).toBeGreaterThan(0)
    expect(creation).toBeLessThan(deletion)
    expect(source).toContain('includeDeletedDeal: true')
  })
})
