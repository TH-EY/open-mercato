import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('payout privacy and convergence source contract', () => {
  it('keeps bank values out of queue, worker, command log/event, and list APIs', () => {
    const paths = [
      'lib/payoutQueue.ts', 'workers/payout-create.ts', 'commands/payouts.ts',
      'api/payouts/route.ts', 'api/portal/payouts/route.ts',
    ]
    for (const path of paths) {
      const source = readFileSync(resolve(process.cwd(), `src/modules/finoo_affiliates/${path}`), 'utf8')
      expect(source).not.toContain('accountHolderName')
      expect(source).not.toContain('accountNumber')
    }
  })

  it('uses one compound command and converges through the preview payout id', () => {
    const worker = readFileSync(resolve(process.cwd(), 'src/modules/finoo_affiliates/workers/payout-create.ts'), 'utf8')
    const payouts = readFileSync(resolve(process.cwd(), 'src/modules/finoo_affiliates/lib/payouts.ts'), 'utf8')
    expect(worker.match(/commandBus\.execute/g)).toHaveLength(1)
    expect(payouts).toContain('if (preview.payoutId)')
    expect(payouts).toContain('lockMode: LockMode.PESSIMISTIC_WRITE')
    expect(payouts).toContain('preview.payoutId = payout.id')
  })
})
