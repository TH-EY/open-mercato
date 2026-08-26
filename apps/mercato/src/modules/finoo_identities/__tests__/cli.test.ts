import {
  parseCompletenessRepairArgs,
  parseLegacyCutoverArgs,
  parseLegacyMigrationArgs,
  parseLegacyPurgeArgs,
  parseLegacyVerifyArgs,
} from '../cli'

const tenantId = '5164d495-1865-4738-b459-2783999a761d'
const organizationId = 'd0d98cb3-28cf-4376-a61c-d270020f166f'

describe('FINOO identity legacy CLI argument gates', () => {
  it('accepts exactly one migration mode and an exact UUID scope', () => {
    expect(parseLegacyMigrationArgs([
      '--tenant', tenantId, '--organization', organizationId, '--dry-run', '--batch-size', '50',
    ])).toEqual({ tenantId, organizationId, mode: 'dry-run', batchSize: 50 })
    expect(parseLegacyMigrationArgs([
      '--tenant', tenantId, '--organization', organizationId, '--dry-run', '--apply',
    ])).toBeNull()
    expect(parseLegacyMigrationArgs([
      '--tenant', '*', '--organization', organizationId, '--dry-run',
    ])).toBeNull()
  })

  it('gates completeness repair to one explicit mode and exact scope', () => {
    expect(parseCompletenessRepairArgs([
      '--tenant', tenantId, '--organization', organizationId, '--dry-run', '--batch-size', '50',
    ])).toEqual({ tenantId, organizationId, mode: 'dry-run', batchSize: 50 })
    expect(parseCompletenessRepairArgs([
      '--tenant', tenantId, '--organization', organizationId, '--dry-run', '--apply',
    ])).toBeNull()
  })

  it('keeps verify read-only and exact-scope only', () => {
    expect(parseLegacyVerifyArgs([
      '--tenant', tenantId, '--organization', organizationId,
    ])).toEqual({ tenantId, organizationId })
    expect(parseLegacyVerifyArgs(['--tenant', tenantId])).toBeNull()
  })

  it('requires the maintenance window and THOM-108 token for cutover and rollback', () => {
    const valid = [
      '--tenant', tenantId,
      '--organization', organizationId,
      '--apply',
      '--maintenance-window',
      '--confirm', 'THOM-108',
    ]
    expect(parseLegacyCutoverArgs(valid)).toEqual({ tenantId, organizationId })
    expect(parseLegacyCutoverArgs(valid.filter((value) => value !== '--maintenance-window'))).toBeNull()
    expect(parseLegacyCutoverArgs(valid.map((value) => value === 'THOM-108' ? 'wrong' : value))).toBeNull()
  })

  it('allows purge dry-run but gates purge apply with the explicit token', () => {
    expect(parseLegacyPurgeArgs([
      '--tenant', tenantId, '--organization', organizationId, '--dry-run',
    ])).toEqual({ tenantId, organizationId, mode: 'dry-run', batchSize: 100 })
    expect(parseLegacyPurgeArgs([
      '--tenant', tenantId, '--organization', organizationId, '--apply',
    ])).toBeNull()
    expect(parseLegacyPurgeArgs([
      '--tenant', tenantId,
      '--organization', organizationId,
      '--apply',
      '--maintenance-window',
      '--confirm', 'THOM-108',
    ])).toEqual({ tenantId, organizationId, mode: 'apply', batchSize: 100 })
  })
})
