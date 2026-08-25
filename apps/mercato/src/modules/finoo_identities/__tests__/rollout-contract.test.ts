import fs from 'node:fs'
import path from 'node:path'

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

describe('FINOO identity private rollout contract', () => {
  it('sets up the exact scope and stops the active writer before final migration and cutover', () => {
    expectOrdered(upgradeScript, [
      'yarn mercato entities seed-encryption',
      'yarn mercato finoo_identities ensure-organization-setup',
      'yarn mercato finoo_identities migrate-legacy',
      '--dry-run)',
      'docker stop --time 30 "$active_container"',
      'identity_apply_report=',
      '--apply)',
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
})
