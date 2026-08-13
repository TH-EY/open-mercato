import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { FINOO_MEMBERSHIP_REPAIR_BATCH_SIZE } from '../membershipRepair'

describe('Finoo affiliate membership repair contract', () => {
  it('processes role assignments in deterministic bounded batches', () => {
    expect(FINOO_MEMBERSHIP_REPAIR_BATCH_SIZE).toBe(100)
    const source = readFileSync(resolve(
      process.cwd(),
      'src/modules/finoo_affiliates/lib/membershipRepair.ts',
    ), 'utf8')
    expect(source).toContain("orderBy: { id: 'ASC' }")
    expect(source).toContain('limit: FINOO_MEMBERSHIP_REPAIR_BATCH_SIZE')
    expect(source).toContain('offset += assignments.length')
  })
})
