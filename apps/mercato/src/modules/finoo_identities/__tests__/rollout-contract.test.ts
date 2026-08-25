import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const upgradeScript = fs.readFileSync(
  path.resolve(__dirname, '../../../../../../infra/aws-upstream-baseline/finoo-demo-upgrade.sh'),
  'utf8',
)

function expectOrdered(source: string, fragments: string[]): void {
  let cursor = -1
  for (const fragment of fragments) {
    const index = source.indexOf(fragment, cursor + 1)
    expect(index).toBeGreaterThan(cursor)
    cursor = index
  }
}

function runIdentityReportNormalizer(output: string) {
  const start = upgradeScript.indexOf('normalize_identity_json_report() {')
  const end = upgradeScript.indexOf('assert_identity_migration_report() {', start)
  const normalizer = upgradeScript.slice(start, end)
  return spawnSync('bash', ['-c', `${normalizer}\nnormalize_identity_json_report "$1"`, 'normalizer-test', output], {
    encoding: 'utf8',
  })
}

describe('FINOO identity private rollout contract', () => {
  it('sets up the exact scope and stops the active writer before final migration and cutover', () => {
    expectOrdered(upgradeScript, [
      'yarn mercato entities seed-encryption',
      'yarn mercato finoo_identities ensure-organization-setup',
      'yarn mercato finoo_identities migrate-legacy',
      '--dry-run)',
      'docker stop --time 30 "$active_container"',
      'identity_apply_output=',
      '--apply)',
      'identity_apply_report=',
      'identity_verification_report=',
      'yarn mercato finoo_identities cutover-legacy',
      '--maintenance-window',
      '--confirm THOM-108',
      'identity_cutover_report=',
      'yarn mercato configs cache structural',
      '--tenant "$finoo_tenant_id"',
      'docker rename "$active_container" "$rollback_container"',
    ])
    expect(upgradeScript).not.toContain('yarn mercato finoo_identities purge-legacy')
  })

  it('restores and verifies the database before either old runtime becomes live', () => {
    const automaticRollback = upgradeScript.slice(
      upgradeScript.indexOf('restore_old() {'),
      upgradeScript.indexOf('cleanup() {'),
    )
    expectOrdered(automaticRollback, [
      'ensure_legacy_identity_state_for_old "$preserved_new"',
      'docker start "$active_container"',
      'wait_for_login "$live_port"',
      'docker stop --time 30 "$active_container"',
      'restore_identity_cutover_for_new "$preserved_new"',
      'restore_preserved_new_runtime "$preserved_new"',
    ])

    const decisionRollback = upgradeScript.slice(
      upgradeScript.lastIndexOf('failed=false'),
      upgradeScript.lastIndexOf('EOF_DECISION'),
    )
    expectOrdered(decisionRollback, [
      'ensure_legacy_identity_state_for_old "$preserved_new"',
      'docker start "$active_container"',
      'wait_for_login',
      'docker stop --time 30 "$active_container"',
      'restore_identity_cutover_for_new "$preserved_new"',
      'restore_preserved_new_runtime "$preserved_new"',
    ])
    expect(upgradeScript).toContain('assert_identity_verification_report "$verification_report" 0 6')
    expect(upgradeScript).toContain('both runtime writers remain stopped')
  })

  it('durably marks the cutover attempt before mutation and resolves crash recovery from counts', () => {
    expectOrdered(upgradeScript, [
      'legacy_cutover_attempted=true',
      "printf 'legacy_cutover_attempted=true\\n' >> \"$pending_file\"",
      'sync "$pending_file"',
      'docker exec "$candidate_container" yarn mercato finoo_identities cutover-legacy',
    ])
    expect(upgradeScript).not.toContain('legacy_cutover_applied')
    expect(upgradeScript).toContain("if (active, inactive) not in {(6, 0), (0, 6)}")
    expect(upgradeScript).toContain('definition_state="$(read_identity_definition_state "$source_container")"')
  })

  it('runs rollback CLI from the immutable new image without publishing another port', () => {
    const helper = upgradeScript.slice(
      upgradeScript.indexOf('run_preserved_new_cli() {'),
      upgradeScript.indexOf('read_identity_definition_state() {'),
    )
    expect(helper).toContain('docker run --rm')
    expect(helper).toContain('--volumes-from "$source_container"')
    expect(helper).toContain('"$immutable_image"')
    expect(helper).not.toContain('--publish')
  })

  it('normalizes count-only JSON from noisy CLI stdout before validation and logging', () => {
    expect(upgradeScript.match(/normalize_identity_json_report\(\) \{/g)).toHaveLength(2)
    expect(upgradeScript).toContain("matches = []")
    expect(upgradeScript).toContain("if len(matches) != 1:")
    expectOrdered(upgradeScript, [
      'identity_dry_run_output=',
      'identity_dry_run_report="$(normalize_identity_json_report "$identity_dry_run_output")"',
      'assert_identity_migration_report "$identity_dry_run_report" dry-run',
      'identity_apply_output=',
      'identity_apply_report="$(normalize_identity_json_report "$identity_apply_output")"',
      'assert_identity_migration_report "$identity_apply_report" apply',
      'identity_verification_output=',
      'identity_verification_report="$(normalize_identity_json_report "$identity_verification_output")"',
      'assert_identity_verification_report "$identity_verification_report" 6 0',
      'identity_cutover_output=',
      'identity_cutover_report="$(normalize_identity_json_report "$identity_cutover_output")"',
      'assert_identity_verification_report "$identity_cutover_report" 0 6',
    ])
    expect(upgradeScript.match(/verification_output="\$\(run_preserved_new_cli/g)).toHaveLength(4)
    expect(upgradeScript.match(/\n  verification_report="\$\(normalize_identity_json_report/g)).toHaveLength(4)
    expect(upgradeScript).not.toContain('identity_dry_run_report="$(docker exec')
    expect(upgradeScript).not.toContain('identity_apply_report="$(docker exec')
    expect(upgradeScript).not.toContain('identity_verification_report="$(docker exec')
    expect(upgradeScript).not.toContain('identity_cutover_report="$(docker exec')
    expect(upgradeScript).not.toContain('verification_report="$(run_preserved_new_cli')
    expect(upgradeScript.match(/--confirm THOM-108 >\/dev\/null/g)).toHaveLength(5)
    expect(upgradeScript).not.toContain('--confirm THOM-108 ||')
  })

  it('accepts one exact count-only report and fails closed on ambiguous or foreign JSON', () => {
    const report = JSON.stringify({
      scanned: 109,
      migrated: 109,
      unmigrated: 0,
      destinationRecords: 109,
      linkedDestinationRecords: 109,
      destinationConflicts: 0,
      aliasValues: 0,
      activeDefinitions: 6,
      inactiveDefinitions: 0,
    })
    const normalized = runIdentityReportNormalizer(`debug banner\n${report}\ncommand complete`)
    expect(normalized.status).toBe(0)
    expect(normalized.stdout.trim()).toBe(
      '{"activeDefinitions":6,"aliasValues":0,"destinationConflicts":0,"destinationRecords":109,"inactiveDefinitions":0,"linkedDestinationRecords":109,"migrated":109,"scanned":109,"unmigrated":0}',
    )

    const ambiguous = runIdentityReportNormalizer(`${report}\n${report}`)
    expect(ambiguous.status).not.toBe(0)
    expect(ambiguous.stderr).toContain('Expected exactly one FINOO identity count-only JSON report')

    const foreign = runIdentityReportNormalizer('{"scanned":109,"secret":"must-not-pass"}')
    expect(foreign.status).not.toBe(0)
    expect(foreign.stderr).toContain('Expected exactly one FINOO identity count-only JSON report')
  })
})
