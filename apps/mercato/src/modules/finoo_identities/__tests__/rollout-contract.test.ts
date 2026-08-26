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

function runIdentityDefinitionStateReader(report: Record<string, unknown>) {
  const start = upgradeScript.indexOf('read_identity_definition_state_from_report() {')
  const end = upgradeScript.indexOf('run_preserved_new_cli() {', start)
  const reader = upgradeScript.slice(start, end)
  return spawnSync(
    'bash',
    ['-c', `${reader}\nread_identity_definition_state_from_report "$1"`, 'definition-state-test', JSON.stringify(report)],
    { encoding: 'utf8' },
  )
}

function runIdentityCompletenessAssertion(
  report: Record<string, unknown>,
  mode: 'dry-run' | 'apply',
  state: 'pending' | 'clean',
) {
  const start = upgradeScript.indexOf('assert_identity_completeness_report() {')
  const end = upgradeScript.indexOf('assert_identity_verification_report() {', start)
  const assertion = upgradeScript.slice(start, end)
  return spawnSync(
    'bash',
    ['-c', `${assertion}\nassert_identity_completeness_report "$1" "$2" "$3"`, 'completeness-test', JSON.stringify(report), mode, state],
    { encoding: 'utf8' },
  )
}

function runIdentityPurgeAssertion(report: Record<string, unknown>) {
  const start = upgradeScript.indexOf('assert_identity_purge_report() {')
  const end = upgradeScript.indexOf('read_identity_definition_state_from_report() {', start)
  const assertion = upgradeScript.slice(start, end)
  return spawnSync(
    'bash',
    ['-c', `${assertion}\nassert_identity_purge_report "$1"`, 'purge-test', JSON.stringify(report)],
    { encoding: 'utf8' },
  )
}

describe('FINOO identity private rollout contract', () => {
  it('sets up the exact scope and stops the active writer before final migration and cutover', () => {
    expectOrdered(upgradeScript, [
      'yarn mercato entities seed-encryption',
      'yarn mercato finoo_identities ensure-organization-setup',
      'yarn mercato finoo_identities migrate-legacy',
      '--dry-run)',
      'yarn mercato finoo_identities repair-completeness',
      'identity_completeness_dry_run_report=',
      'docker stop --time 30 "$active_container"',
      'identity_apply_output=',
      '--apply)',
      'identity_apply_report=',
      'identity_completeness_apply_output=',
      'identity_completeness_apply_report=',
      'identity_completeness_verify_output=',
      'identity_completeness_verify_report=',
      'identity_verification_report=',
      'yarn mercato finoo_identities cutover-legacy',
      '--maintenance-window',
      '--confirm THOM-108',
      'identity_cutover_report=',
      'yarn mercato configs cache structural',
      '--tenant "$finoo_tenant_id"',
      'docker rename "$active_container" "$rollback_container"',
    ])
    expect(upgradeScript.match(/finoo_identities purge-legacy/g)).toHaveLength(2)
    expect(upgradeScript.match(/finoo_identities purge-legacy \\\n[\s\S]*?--dry-run/g)).toHaveLength(2)
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
    expect(upgradeScript.match(
      /\[\[ "\$definition_state" == "0 6" \|\| "\$definition_state" == "0 0" \]\] \|\| return 1/g,
    )).toHaveLength(2)
    expect(upgradeScript).toContain('both runtime writers remain stopped')
  })

  it('preserves an already-cut-over legacy definition state across an idempotent rollout', () => {
    expectOrdered(upgradeScript, [
      'identity_definition_state="$(read_identity_definition_state_from_report "$identity_verification_report")"',
      'expected_inactive_definitions=6',
      'if [[ "$identity_definition_state" == "6 0" ]]',
      'legacy_cutover_attempted=true',
      "printf 'legacy_cutover_attempted=true\\n' >> \"$pending_file\"",
      'yarn mercato finoo_identities cutover-legacy',
      'assert_identity_verification_report "$identity_cutover_report" 0 "$expected_inactive_definitions" "$finoo_expected_identity_records"',
    ])
    expect(upgradeScript.match(/read_identity_definition_state_from_report\(\) \{/g)).toHaveLength(2)
    expect(upgradeScript.match(/if \[\[ "\$legacy_cutover_attempted" != true \]\]; then/g)).toHaveLength(2)

    const rollbackHelpers = upgradeScript.match(/ensure_legacy_identity_state_for_old\(\) \{[\s\S]*?\n\}/g)
    expect(rollbackHelpers).toHaveLength(2)
    for (const helper of rollbackHelpers ?? []) {
      expectOrdered(helper, [
        'definition_state="$(read_identity_definition_state "$source_container")"',
        'if [[ "$legacy_cutover_attempted" != true ]]',
        'return 0',
        'if [[ "$definition_state" == "0 6" ]]',
        'finoo_identities rollback-legacy',
      ])
    }
  })

  it('durably marks the cutover attempt before mutation and resolves crash recovery from counts', () => {
    expectOrdered(upgradeScript, [
      'legacy_cutover_attempted=true',
      "printf 'legacy_cutover_attempted=true\\n' >> \"$pending_file\"",
      'sync "$pending_file"',
      'docker exec "$candidate_container" yarn mercato finoo_identities cutover-legacy',
    ])
    expect(upgradeScript).not.toContain('legacy_cutover_applied')
    expect(upgradeScript).toContain("if (active, inactive) not in {(6, 0), (0, 6), (0, 0)}")
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
      'identity_completeness_dry_run_output=',
      'identity_completeness_dry_run_report="$(normalize_identity_json_report "$identity_completeness_dry_run_output")"',
      'assert_identity_completeness_report "$identity_completeness_dry_run_report" dry-run pending',
      'identity_apply_output=',
      'identity_apply_report="$(normalize_identity_json_report "$identity_apply_output")"',
      'assert_identity_migration_report "$identity_apply_report" apply',
      'identity_completeness_apply_output=',
      'identity_completeness_apply_report="$(normalize_identity_json_report "$identity_completeness_apply_output")"',
      'assert_identity_completeness_report "$identity_completeness_apply_report" apply clean',
      'identity_completeness_verify_output=',
      'identity_completeness_verify_report="$(normalize_identity_json_report "$identity_completeness_verify_output")"',
      'assert_identity_completeness_report "$identity_completeness_verify_report" dry-run clean',
      'identity_verification_output=',
      'identity_verification_report="$(normalize_identity_json_report "$identity_verification_output")"',
      'identity_definition_state="$(read_identity_definition_state_from_report "$identity_verification_report")"',
      'identity_cutover_output=',
      'identity_cutover_report="$(normalize_identity_json_report "$identity_cutover_output")"',
      'assert_identity_verification_report "$identity_cutover_report" 0 "$expected_inactive_definitions" "$finoo_expected_identity_records"',
    ])
    expect(upgradeScript.match(/verification_output="\$\(run_preserved_new_cli/g)).toHaveLength(4)
    expect(upgradeScript.match(/\n\s+verification_report="\$\(normalize_identity_json_report/g)).toHaveLength(4)
    expect(upgradeScript).not.toContain('identity_dry_run_report="$(docker exec')
    expect(upgradeScript).not.toContain('identity_apply_report="$(docker exec')
    expect(upgradeScript).not.toContain('identity_verification_report="$(docker exec')
    expect(upgradeScript).not.toContain('identity_cutover_report="$(docker exec')
    expect(upgradeScript).not.toContain('verification_report="$(run_preserved_new_cli')
    expect(upgradeScript.match(/--confirm THOM-108 >\/dev\/null/g)).toHaveLength(5)
    expect(upgradeScript).not.toContain('--confirm THOM-108 ||')
  })

  it('fails closed on completeness conflicts and requires a clean post-apply dry-run', () => {
    const base = {
      mode: 'dry-run',
      scanned: 100,
      countryConflicts: 0,
      countriesNormalized: 0,
      completenessUpdated: 0,
      wouldNormalizeCountries: 4,
      wouldUpdateCompleteness: 4,
    }
    expect(runIdentityCompletenessAssertion(base, 'dry-run', 'pending').status).toBe(0)
    expect(runIdentityCompletenessAssertion(
      { ...base, countryConflicts: 1 },
      'dry-run',
      'pending',
    ).status).not.toBe(0)
    expect(runIdentityCompletenessAssertion(base, 'dry-run', 'clean').status).not.toBe(0)
    expect(runIdentityCompletenessAssertion(
      { ...base, wouldNormalizeCountries: 0, wouldUpdateCompleteness: 0 },
      'dry-run',
      'clean',
    ).status).toBe(0)
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

  it.each([
    [6, 0, 100, 100, '6 0'],
    [0, 6, 100, 100, '0 6'],
    [0, 0, 0, 0, '0 0'],
  ])('accepts exact definition state %i/%i', (
    activeDefinitions,
    inactiveDefinitions,
    scanned,
    linkedDestinationRecords,
    expected,
  ) => {
    const result = runIdentityDefinitionStateReader({
      scanned,
      migrated: scanned,
      unmigrated: 0,
      destinationRecords: 101,
      linkedDestinationRecords,
      destinationConflicts: 0,
      aliasValues: 0,
      activeDefinitions,
      inactiveDefinitions,
    })
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe(expected)
  })

  it('rejects a partial legacy definition state', () => {
    const result = runIdentityDefinitionStateReader({
      scanned: 100,
      migrated: 100,
      unmigrated: 0,
      destinationRecords: 101,
      linkedDestinationRecords: 100,
      destinationConflicts: 0,
      aliasValues: 0,
      activeDefinitions: 1,
      inactiveDefinitions: 5,
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('FINOO identity definitions are in a partial state')
  })

  it('keeps a fully purged legacy state without attempting another cutover', () => {
    expect(upgradeScript).toContain('if [[ "$identity_definition_state" == "0 0" ]]')
    expect(upgradeScript).toContain('expected_inactive_definitions=0')
    expect(upgradeScript).toContain(
      'assert_identity_verification_report "$identity_cutover_report" 0 "$expected_inactive_definitions" "$finoo_expected_identity_records"',
    )
    expect(upgradeScript.match(/verify_identity_purge_state\(\) \{/g)).toHaveLength(2)
    expect(upgradeScript.match(/if \[\[ "\$definition_state" == "0 0" \]\]; then/g)).toHaveLength(2)
  })

  it('rejects a purged definition state with active legacy values', () => {
    const result = runIdentityDefinitionStateReader({
      scanned: 1,
      migrated: 1,
      unmigrated: 0,
      destinationRecords: 101,
      linkedDestinationRecords: 1,
      destinationConflicts: 0,
      aliasValues: 0,
      activeDefinitions: 0,
      inactiveDefinitions: 0,
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('FINOO identity purged definition state still has active legacy values')
  })

  it('accepts only a zero-residue count-only purge report', () => {
    const clean = {
      mode: 'dry-run',
      values: 0,
      definitions: 0,
      auditLogs: 0,
      residualValues: 0,
      residualDefinitions: 0,
      residualAuditLogs: 0,
    }
    expect(runIdentityPurgeAssertion(clean).status).toBe(0)
    const residual = runIdentityPurgeAssertion({ ...clean, residualValues: 1 })
    expect(residual.status).not.toBe(0)
    expect(residual.stderr).toContain('FINOO identity purge verification found legacy residue')
  })

  it.each([
    ['boolean count', { scanned: true }, 'Unexpected FINOO identity definition-state report'],
    ['scanned count', { scanned: 99 }, 'FINOO identity scanned count does not reconcile'],
    ['unmigrated records', { migrated: 99, unmigrated: 1, linkedDestinationRecords: 99 }, 'FINOO identity migration is not safe for cutover'],
    ['destination conflicts', { migrated: 99, destinationConflicts: 1 }, 'FINOO identity migration is not safe for cutover'],
    ['prefixed aliases', { aliasValues: 1 }, 'FINOO identity migration has prefixed legacy aliases'],
    ['linked destination count', { linkedDestinationRecords: 99 }, 'FINOO identity linked destination count does not reconcile'],
    ['destination count', { destinationRecords: 99 }, 'FINOO identity destination count is inconsistent'],
  ])('rejects an unsafe %s report', (_name, overrides, expectedError) => {
    const result = runIdentityDefinitionStateReader({
      scanned: 100,
      migrated: 100,
      unmigrated: 0,
      destinationRecords: 101,
      linkedDestinationRecords: 100,
      destinationConflicts: 0,
      aliasValues: 0,
      activeDefinitions: 0,
      inactiveDefinitions: 6,
      ...overrides,
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain(expectedError)
  })
})
