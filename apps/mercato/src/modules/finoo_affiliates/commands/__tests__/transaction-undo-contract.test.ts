import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('affiliate transaction command undo contract', () => {
  it('captures before and after snapshots and delegates guarded restoration', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/modules/finoo_affiliates/commands/transactions.ts'), 'utf8')
    const transition = source.slice(source.indexOf('const transitionTransactionCommand'))
    expect(transition).toContain('isUndoable: true')
    expect(transition).toContain('captureAfter:')
    expect(transition).toContain('snapshotBefore: before')
    expect(transition).toContain('snapshotAfter: after')
    expect(transition).toContain('extractUndoPayload<TransitionUndoPayload>')
    expect(transition).toContain('undoAffiliateTransactionTransition')
  })
})
