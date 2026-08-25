import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type APIRequestContext } from '@playwright/test'
import { createPersonFixture } from '@open-mercato/core/helpers/integration/crmFixtures'
import {
  cleanupScenario,
  createScenario,
  queryDatabase,
  scopedApiRequest,
  type Scenario,
} from '../../finoo_intermediaries/__integration__/helpers'

export const integrationMeta = {
  dependsOnModules: [
    'finoo_customer_retention',
    'finoo_identities',
    'finoo_applications',
  ],
}

test.setTimeout(120_000)

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', '..')
const appRoot = resolve(process.env.OM_TEST_APP_ROOT?.trim() || join(repoRoot, 'apps', 'mercato'))
const cliBin = join(repoRoot, 'packages', 'cli', 'dist', 'bin.js')
const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx')
const retentionRunner = join(dirname(fileURLToPath(import.meta.url)), 'retention-runner.ts')
const features = [
  'finoo_intermediaries.view',
  'finoo_intermediaries.manage',
  'customer_accounts.view',
  'customer_accounts.manage',
  'customer_accounts.roles.manage',
  'customer_accounts.invite',
  'communication_channels.connect_user_channel',
  'customers.deals.view',
  'customers.deals.manage',
  'customers.pipelines.manage',
  'customers.companies.manage',
  'customers.people.view',
  'customers.people.manage',
  'customers.activities.view',
  'customers.activities.manage',
  'entities.definitions.manage',
  'finoo_identities.view',
  'finoo_identities.manage',
]

type CliReport = {
  tenantId: string
  organizationId: string
  mode: 'dry-run' | 'apply'
  batchSize: number
  eligibleCount: number
  selectedCount: number
  processedCount: number
}

type PersonCopies = {
  personId: string
  profileId: string
}

const identityInput = {
  pesel: '44051401458',
  documentType: 'identity_card',
  issuingCountryCode: 'PL',
  documentNumber: 'TCRET007DOC',
  issuedOn: '2024-01-10',
  expiresOn: '2034-01-10',
}

function parseCliReport(output: string): CliReport {
  for (const line of output.trim().split('\n').reverse()) {
    try {
      const parsed = JSON.parse(line) as Partial<CliReport>
      if (parsed.mode === 'dry-run' || parsed.mode === 'apply') return parsed as CliReport
    } catch {
      continue
    }
  }
  throw new Error('[internal] Retention erasure CLI did not return a count report')
}

function runErasureCli(scenario: Scenario, mode: 'dry-run' | 'apply', batchSize = 25): {
  output: string
  report: CliReport
} {
  const modeArgs = mode === 'dry-run'
    ? ['--dry-run']
    : ['--apply', '--maintenance-window', '--confirm', 'THOM-108']
  const output = execFileSync(process.execPath, [
    cliBin,
    'finoo_customer_retention',
    'erase-expired-identities',
    '--tenant', scenario.tenantId,
    '--organization', scenario.organizationId,
    ...modeArgs,
    '--batch-size', String(batchSize),
  ], {
    cwd: appRoot,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0', NODE_NO_WARNINGS: '1' },
  })
  return { output, report: parseCliReport(output) }
}

async function createIdentityCopies(
  request: APIRequestContext,
  scenario: Scenario,
  label: string,
): Promise<PersonCopies> {
  const personId = await createPersonFixture(request, scenario.token, {
    firstName: 'Retention',
    lastName: label,
    displayName: `TC-FINOO-RET-007 ${label}`,
  })
  const identityResponse = await scopedApiRequest(
    request,
    scenario,
    'PUT',
    `/api/finoo_identities/people/${personId}`,
    { ...identityInput, documentNumber: `${identityInput.documentNumber}-${label}` },
  )
  expect(identityResponse.status()).toBe(200)
  const profile = (await queryDatabase<{ id: string }>(
    `select profile.id from customer_people profile
     inner join customer_entities entity on entity.id = profile.entity_id
     where profile.tenant_id=$1 and profile.organization_id=$2 and profile.entity_id=$3
       and entity.deleted_at is null`,
    [scenario.tenantId, scenario.organizationId, personId],
  ))[0]
  expect(profile?.id).toBeTruthy()

  await queryDatabase(
    `insert into finoo_identity_import_conflicts
       (id,tenant_id,organization_id,person_id,source_module,source_record_id,candidate_digest,
        changed_fields,state,created_at,updated_at)
     values(gen_random_uuid(),$1,$2,$3,'finoo_customer_retention',$4,$5,array['pesel'],'open',now(),now())`,
    [scenario.tenantId, scenario.organizationId, personId, randomUUID(), `fixture-${randomUUID()}`],
  )
  await queryDatabase(
    `insert into custom_field_values
       (id,tenant_id,organization_id,entity_id,record_id,field_key,value_text,created_at)
     values(gen_random_uuid(),$1,$2,'customers:customer_person_profile',$3,
       'national_identification_number','retention-fixture',now())`,
    [scenario.tenantId, scenario.organizationId, profile!.id],
  )
  return { personId, profileId: profile!.id }
}

async function createApplicationCopies(scenario: Scenario, personId: string): Promise<string> {
  const result = runRetentionHelper(scenario, [
    'create-application-copies',
    personId,
    identityInput.pesel,
    identityInput.documentNumber,
  ]) as { intakeId: string }
  return result.intakeId
}

function runRetentionHelper(scenario: Scenario, args: string[]): Record<string, unknown> {
  const output = execFileSync(tsxBin, [retentionRunner, ...args], {
    cwd: appRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      OM_FINOO_RETENTION_TENANT_ID: scenario.tenantId,
      OM_FINOO_RETENTION_ORGANIZATION_ID: scenario.organizationId,
      FORCE_COLOR: '0',
      NODE_NO_WARNINGS: '1',
    },
  })
  const resultLine = output.trim().split(/\r?\n/)
    .find((line) => line.startsWith('FINOO_RETENTION_RESULT '))
  if (resultLine) {
    return JSON.parse(resultLine.slice('FINOO_RETENTION_RESULT '.length)) as Record<string, unknown>
  }
  throw new Error('[internal] FINOO retention helper returned no JSON result')
}

function readApplicationPayload(scenario: Scenario, intakeId: string): Record<string, unknown> | null {
  const result = runRetentionHelper(scenario, ['read-application-payload', intakeId]) as {
    payload: Record<string, unknown> | null
  }
  return result.payload
}

async function insertRetentionState(
  scenario: Scenario,
  personId: string,
  status: 'active' | 'expired',
  expiryExpression: "now()-interval '1 day'" | "now()+interval '1 day'",
): Promise<void> {
  await queryDatabase(
    `insert into finoo_customer_retention_states
       (id,tenant_id,organization_id,customer_entity_id,retention_status,eligibility_anchor_at,
        retention_expires_at,expired_at,last_evaluated_at,created_at,updated_at)
     values(gen_random_uuid(),$1,$2,$3,$4,now()-interval '30 days',${expiryExpression},
       case when $4='expired' then now() else null end,now(),now(),now())
     on conflict (tenant_id,organization_id,customer_entity_id) where deleted_at is null
     do update set retention_status=excluded.retention_status,
       eligibility_anchor_at=excluded.eligibility_anchor_at,
       retention_expires_at=excluded.retention_expires_at,
       expired_at=excluded.expired_at,
       last_evaluated_at=excluded.last_evaluated_at,
       updated_at=excluded.updated_at`,
    [scenario.tenantId, scenario.organizationId, personId, status],
  )
}

async function countRows(table: string, scenario: Scenario, personColumn: string, personId: string) {
  const allowed = new Set([
    'finoo_person_identities:person_id',
    'finoo_identity_import_conflicts:person_id',
    'finoo_application_identity_bindings:customer_entity_id',
  ])
  if (!allowed.has(`${table}:${personColumn}`)) throw new Error('[internal] Unsupported count target')
  return Number((await queryDatabase<{ count: string }>(
    `select count(*)::text count from ${table}
     where tenant_id=$1 and organization_id=$2 and ${personColumn}=$3`,
    [scenario.tenantId, scenario.organizationId, personId],
  ))[0]?.count ?? 0)
}

async function cleanup(request: APIRequestContext, scenario: Scenario | null): Promise<void> {
  if (scenario) {
    const values = [scenario.tenantId, scenario.organizationId]
    await queryDatabase('delete from finoo_identity_import_conflicts where tenant_id=$1 and organization_id=$2', values)
    await queryDatabase('delete from finoo_identity_audit_entries where tenant_id=$1 and organization_id=$2', values)
    await queryDatabase('delete from finoo_person_identities where tenant_id=$1 and organization_id=$2', values)
    await queryDatabase('delete from finoo_application_identity_bindings where tenant_id=$1 and organization_id=$2', values)
    await queryDatabase('delete from finoo_application_projections where tenant_id=$1 and organization_id=$2', values)
    await queryDatabase('delete from finoo_application_intakes where tenant_id=$1 and organization_id=$2', values)
    await queryDatabase('delete from custom_field_values where tenant_id=$1 and organization_id=$2', values)
    await queryDatabase('delete from finoo_customer_retention_states where tenant_id=$1 and organization_id=$2', values)
    await queryDatabase('delete from finoo_customer_retention_settings where tenant_id=$1 and organization_id=$2', values)
  }
  await cleanupScenario(request, scenario)
}

test('TC-FINOO-RET-007 confirmed erasure follows the scoped due retention clock', async ({ request }) => {
  let scenario: Scenario | null = null
  let foreignScenario: Scenario | null = null
  try {
    scenario = await createScenario(request, 'TC-FINOO-RET-007', features)
    foreignScenario = await createScenario(request, 'TC-FINOO-RET-007-FOREIGN', features)
    const due = await createIdentityCopies(request, scenario, 'due')
    const dueSecond = await createIdentityCopies(request, scenario, 'due-second')
    const future = await createIdentityCopies(request, scenario, 'future')
    const active = await createIdentityCopies(request, scenario, 'active')
    const stale = await createIdentityCopies(request, scenario, 'stale')
    const foreign = await createIdentityCopies(request, foreignScenario, 'foreign')
    const intakeId = await createApplicationCopies(scenario, due.personId)

    for (const current of [scenario, foreignScenario]) {
      await queryDatabase(
        `insert into finoo_customer_retention_settings
           (id,tenant_id,organization_id,inactivity_window_days,reconciliation_generation,created_at,updated_at)
         values(gen_random_uuid(),$1,$2,1,1,now(),now())
         on conflict (tenant_id,organization_id) do update
         set inactivity_window_days=1,reconciliation_generation=1,updated_at=now()`,
        [current.tenantId, current.organizationId],
      )
    }
    await queryDatabase(
      `update customer_entities set created_at=now()-interval '2 days'
       where id=any($1::uuid[])`,
      [[due.personId, dueSecond.personId, stale.personId]],
    )
    await insertRetentionState(scenario, due.personId, 'expired', "now()-interval '1 day'")
    await insertRetentionState(scenario, dueSecond.personId, 'expired', "now()-interval '1 day'")
    await insertRetentionState(scenario, future.personId, 'expired', "now()+interval '1 day'")
    await insertRetentionState(scenario, active.personId, 'active', "now()-interval '1 day'")
    await insertRetentionState(scenario, stale.personId, 'expired', "now()-interval '1 day'")
    await insertRetentionState(foreignScenario, foreign.personId, 'expired', "now()-interval '1 day'")
    await queryDatabase(
      `insert into customer_comments
         (id,tenant_id,organization_id,entity_id,body,created_at,updated_at)
       values(gen_random_uuid(),$1,$2,$3,'TC-FINOO-RET-007 authoritative activity',now(),now())`,
      [scenario.tenantId, scenario.organizationId, stale.personId],
    )
    await queryDatabase(
      `update finoo_customer_retention_states
       set retention_status='expired',retention_expires_at=now()-interval '1 day',
           expired_at=now()-interval '1 day',last_evaluated_at=now()-interval '1 minute',
           identity_erased_at=null,updated_at=now()
       where tenant_id=$1 and organization_id=$2 and customer_entity_id=$3`,
      [scenario.tenantId, scenario.organizationId, stale.personId],
    )

    const dryRun = runErasureCli(scenario, 'dry-run', 1)
    expect(dryRun.report).toEqual({
      tenantId: scenario.tenantId,
      organizationId: scenario.organizationId,
      mode: 'dry-run',
      batchSize: 1,
      eligibleCount: 3,
      selectedCount: 1,
      processedCount: 0,
    })
    expect(Object.keys(dryRun.report).sort()).toEqual([
      'batchSize', 'eligibleCount', 'mode', 'organizationId',
      'processedCount', 'selectedCount', 'tenantId',
    ])
    expect(dryRun.output).not.toContain(identityInput.pesel)
    expect(dryRun.output).not.toContain(identityInput.documentNumber)
    expect(await countRows('finoo_person_identities', scenario, 'person_id', due.personId)).toBe(1)
    expect(await countRows('finoo_identity_import_conflicts', scenario, 'person_id', due.personId)).toBe(1)
    expect(await countRows('finoo_application_identity_bindings', scenario, 'customer_entity_id', due.personId)).toBe(1)
    expect(readApplicationPayload(scenario, intakeId)).toMatchObject({
      leadId: expect.any(String),
      completed: true,
      name: 'Retention fixture',
      pesel: identityInput.pesel,
      idCard: identityInput.documentNumber,
    })

    const firstBatch = runErasureCli(scenario, 'apply', 1)
    const secondBatch = runErasureCli(scenario, 'apply', 1)
    const thirdBatch = runErasureCli(scenario, 'apply', 1)
    expect(firstBatch.report.selectedCount).toBe(1)
    expect(secondBatch.report.selectedCount).toBe(1)
    expect(thirdBatch.report.selectedCount).toBe(1)
    expect(
      firstBatch.report.processedCount
      + secondBatch.report.processedCount
      + thirdBatch.report.processedCount,
    ).toBe(2)
    expect(firstBatch.output).not.toContain(identityInput.pesel)
    expect(secondBatch.output).not.toContain(identityInput.documentNumber)
    expect(thirdBatch.output).not.toContain(identityInput.documentNumber)
    expect(await countRows('finoo_person_identities', scenario, 'person_id', due.personId)).toBe(0)
    expect(await countRows('finoo_person_identities', scenario, 'person_id', dueSecond.personId)).toBe(0)
    expect(await countRows('finoo_identity_import_conflicts', scenario, 'person_id', due.personId)).toBe(0)
    expect(await countRows('finoo_application_identity_bindings', scenario, 'customer_entity_id', due.personId)).toBe(0)
    expect((await queryDatabase<{ count: string }>(
      `select count(*)::text count from custom_field_values
       where tenant_id=$1 and organization_id=$2 and record_id=$3
         and field_key='national_identification_number'`,
      [scenario.tenantId, scenario.organizationId, due.profileId],
    ))[0]?.count).toBe('0')
    expect((await queryDatabase<{ count: string }>(
      `select count(*)::text count from finoo_identity_audit_entries
       where tenant_id=$1 and organization_id=$2 and person_id=$3`,
      [scenario.tenantId, scenario.organizationId, due.personId],
    ))[0]?.count).toBe('0')
    expect((await queryDatabase<{ count: string }>(
      `select count(*)::text count from finoo_identity_audit_entries
       where tenant_id=$1 and organization_id=$2 and person_id is null and operation='erase'`,
      [scenario.tenantId, scenario.organizationId],
    ))[0]?.count).toBe('2')
    expect(readApplicationPayload(scenario, intakeId)).toMatchObject({
      leadId: expect.any(String),
      completed: true,
      name: 'Retention fixture',
    })
    expect(readApplicationPayload(scenario, intakeId)).not.toHaveProperty('pesel')
    expect(readApplicationPayload(scenario, intakeId)).not.toHaveProperty('idCard')

    expect(await countRows('finoo_person_identities', scenario, 'person_id', future.personId)).toBe(1)
    expect(await countRows('finoo_person_identities', scenario, 'person_id', active.personId)).toBe(1)
    expect(await countRows('finoo_person_identities', scenario, 'person_id', stale.personId)).toBe(1)
    expect(await countRows('finoo_person_identities', foreignScenario, 'person_id', foreign.personId)).toBe(1)
    expect(await countRows('finoo_identity_import_conflicts', foreignScenario, 'person_id', foreign.personId)).toBe(1)

    expect((await queryDatabase<{ retention_status: string }>(
      `select retention_status from finoo_customer_retention_states
       where tenant_id=$1 and organization_id=$2 and customer_entity_id=$3`,
      [scenario.tenantId, scenario.organizationId, stale.personId],
    ))[0]?.retention_status).toBe('active')
    const finalDryRun = runErasureCli(scenario, 'dry-run', 1)
    expect(finalDryRun.report).toMatchObject({ eligibleCount: 0, selectedCount: 0, processedCount: 0 })
    const rerun = runErasureCli(scenario, 'apply', 1)
    expect(rerun.report).toMatchObject({ eligibleCount: 0, selectedCount: 0, processedCount: 0 })
    expect(await countRows('finoo_person_identities', scenario, 'person_id', due.personId)).toBe(0)
    expect(await countRows('finoo_person_identities', scenario, 'person_id', dueSecond.personId)).toBe(0)
    expect(await countRows('finoo_identity_import_conflicts', scenario, 'person_id', due.personId)).toBe(0)
    expect(await countRows('finoo_application_identity_bindings', scenario, 'customer_entity_id', due.personId)).toBe(0)
    expect(readApplicationPayload(scenario, intakeId)).toMatchObject({
      leadId: expect.any(String),
      completed: true,
      name: 'Retention fixture',
    })
    expect(readApplicationPayload(scenario, intakeId)).not.toHaveProperty('pesel')
    expect(readApplicationPayload(scenario, intakeId)).not.toHaveProperty('idCard')

    const recreateResponse = await scopedApiRequest(
      request,
      scenario,
      'PUT',
      `/api/finoo_identities/people/${due.personId}`,
      { ...identityInput, documentNumber: `${identityInput.documentNumber}-recreated` },
    )
    expect(recreateResponse.status()).toBe(200)
    expect((await queryDatabase<{ identity_erased_at: Date | null }>(
      `select identity_erased_at from finoo_customer_retention_states
       where tenant_id=$1 and organization_id=$2 and customer_entity_id=$3`,
      [scenario.tenantId, scenario.organizationId, due.personId],
    ))[0]?.identity_erased_at).toBeNull()
    expect(runErasureCli(scenario, 'dry-run', 1).report).toMatchObject({
      eligibleCount: 1,
      selectedCount: 1,
      processedCount: 0,
    })
    expect(runErasureCli(scenario, 'apply', 1).report).toMatchObject({
      eligibleCount: 1,
      selectedCount: 1,
      processedCount: 1,
    })
    expect(runErasureCli(scenario, 'dry-run', 1).report).toMatchObject({
      eligibleCount: 0,
      selectedCount: 0,
      processedCount: 0,
    })
    expect(await countRows('finoo_person_identities', scenario, 'person_id', due.personId)).toBe(0)
  } finally {
    await cleanup(request, foreignScenario)
    await cleanup(request, scenario)
  }
})
