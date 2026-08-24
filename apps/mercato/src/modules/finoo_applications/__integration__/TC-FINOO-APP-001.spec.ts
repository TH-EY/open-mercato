import { randomUUID } from 'node:crypto'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type APIRequestContext } from '@playwright/test'
import { drainIntegrationQueue } from '@open-mercato/core/helpers/integration/queue'
import { createDictionaryFixture } from '@open-mercato/core/helpers/integration/dictionariesFixtures'
import { hashForLookup } from '@open-mercato/shared/lib/encryption/aes'
import { FINOO_APPLICATION_SENSITIVE_FIELD_SPECS } from '../lib/sensitive-fields'
import { FINOO_CONSENT_REGISTRY_VERSION } from '../lib/consents'
import {
  cleanupScenario,
  createFieldDefinition,
  createScenario,
  queryDatabase,
  scopedApiRequest,
  type Scenario,
} from '../../finoo_intermediaries/__integration__/helpers'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', '..')
const appDir = join(repoRoot, 'apps', 'mercato')
const cliBin = join(repoRoot, 'packages', 'cli', 'dist', 'bin.js')
const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx')
const intakeRunner = join(dirname(fileURLToPath(import.meta.url)), 'intake-runner.ts')
const signingSecret = 'integration-finoo-signing-secret-000000000000000000'
const execFileAsync = promisify(execFile)

type IntakeResponse = { ok?: boolean; duplicate?: boolean; intakeId?: string }

async function createDictionaryEntry(
  request: APIRequestContext,
  scenario: Scenario,
  dictionaryId: string,
  value: string,
): Promise<string> {
  const response = await scopedApiRequest(
    request,
    scenario,
    'POST',
    `/api/dictionaries/${encodeURIComponent(dictionaryId)}/entries`,
    { value, label: value },
  )
  expect(response.status()).toBe(201)
  return ((await response.json()) as { id: string }).id
}

async function createPipeline(request: APIRequestContext, scenario: Scenario): Promise<void> {
  const pipelineResponse = await scopedApiRequest(request, scenario, 'POST', '/api/customers/pipelines', {
    name: 'Web Form Sales Pipeline',
    isDefault: false,
  })
  expect(pipelineResponse.status()).toBe(201)
  const pipelineId = ((await pipelineResponse.json()) as { id: string }).id
  for (const label of ['Created', 'Submitted', 'Closed']) {
    const stageResponse = await scopedApiRequest(request, scenario, 'POST', '/api/customers/pipeline-stages', {
      pipelineId,
      label,
    })
    expect(stageResponse.status()).toBe(201)
  }
}

async function createFieldManifest(request: APIRequestContext, scenario: Scenario): Promise<string> {
  for (const spec of FINOO_APPLICATION_SENSITIVE_FIELD_SPECS) {
    await createFieldDefinition(request, scenario, {
      entityId: spec.entityId,
      key: spec.key,
      kind: spec.kind,
      configJson: { label: spec.key },
    })
  }
  const companyTypeDictionaryId = await createDictionaryFixture(request, scenario.token, {
    key: `finoo_company_type_${randomUUID().slice(0, 8)}`,
    name: 'FINOO company type',
  })
  const companyTypeEntryId = await createDictionaryEntry(request, scenario, companyTypeDictionaryId, 'private_limited_company')
  await createFieldDefinition(request, scenario, {
    entityId: 'customers:customer_company_profile',
    key: 'company_type',
    kind: 'dictionary',
    configJson: { label: 'company_type', dictionaryId: companyTypeDictionaryId },
  })
  await createFieldDefinition(request, scenario, {
    entityId: 'customers:customer_deal',
    key: 'external_id',
    kind: 'text',
  })
  await createFieldDefinition(request, scenario, {
    entityId: 'customers:customer_deal',
    key: 'form_complete',
    kind: 'boolean',
  })
  await createFieldDefinition(request, scenario, {
    entityId: 'customers:customer_deal',
    key: 'turnover',
    kind: 'integer',
  })
  await createFieldDefinition(request, scenario, {
    entityId: 'customers:customer_deal',
    key: 'traffic_source',
    kind: 'text',
  })
  return companyTypeEntryId
}

async function createUnownedCompany(request: APIRequestContext, scenario: Scenario, displayName: string): Promise<string> {
  const response = await scopedApiRequest(request, scenario, 'POST', '/api/customers/companies', { displayName })
  expect(response.status()).toBe(201)
  const body = (await response.json()) as { id?: string; entityId?: string }
  const id = body.id ?? body.entityId
  expect(id).toBeTruthy()
  return id!
}

async function createUnownedPerson(
  request: APIRequestContext,
  scenario: Scenario,
  email: string,
  options: { firstName?: string; lastName?: string; source?: string; companyEntityId?: string } = {},
): Promise<string> {
  const firstName = options.firstName ?? 'Existing'
  const lastName = options.lastName ?? 'Person'
  const response = await scopedApiRequest(request, scenario, 'POST', '/api/customers/people', {
    firstName,
    lastName,
    displayName: `${firstName} ${lastName}`,
    primaryEmail: email,
    ...(options.source ? { source: options.source } : {}),
    ...(options.companyEntityId ? { companyEntityId: options.companyEntityId } : {}),
  })
  expect(response.status()).toBe(201)
  const body = (await response.json()) as { id?: string; entityId?: string }
  const id = body.id ?? body.entityId
  expect(id).toBeTruthy()
  return id!
}

async function insertIdentityBinding(
  scenario: Scenario,
  kind: 'nip' | 'pesel' | 'email',
  rawValue: string,
  projectionId: string | null,
  customerEntityId: string | null,
  reservedEntityId: string = randomUUID(),
): Promise<void> {
  const identityHash = hashForLookup(
    rawValue.trim().toLowerCase(),
    `finoo_application:${scenario.tenantId}:${scenario.organizationId}:${kind}`,
  )
  await queryDatabase(
    `insert into finoo_application_identity_bindings
      (id, tenant_id, organization_id, projection_id, identity_kind, identity_hash, reserved_entity_id,
       customer_entity_id, created_at, updated_at)
     values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, now(), now())`,
    [scenario.tenantId, scenario.organizationId, projectionId, kind, identityHash, reservedEntityId, customerEntityId],
  )
}

function prepareEncryption(scenario: Scenario): void {
  const output = execFileSync(
    process.execPath,
    [
      cliBin,
      'finoo_applications',
      'prepare-encryption',
      '--tenant', scenario.tenantId,
      '--organization', scenario.organizationId,
      '--apply',
      '--maintenance-window',
      '--confirm', scenario.tenantId,
    ],
    {
      cwd: appDir,
      encoding: 'utf8',
      env: { ...process.env, FORCE_COLOR: '0', NODE_NO_WARNINGS: '1' },
    },
  )
  expect(output).toContain('"ok":true')
  expect(output).toMatch(/"coreRowsToEncrypt":[1-9][0-9]*/)
  expect(output).toMatch(/"coreMapsToEnable":[1-9][0-9]*/)
}

function replayIntake(scenario: Scenario, intakeId: string): void {
  const output = execFileSync(
    process.execPath,
    [
      cliBin,
      'finoo_applications',
      'replay',
      '--tenant', scenario.tenantId,
      '--organization', scenario.organizationId,
      '--intake', intakeId,
      '--confirm', intakeId,
    ],
    {
      cwd: appDir,
      encoding: 'utf8',
      env: intakeHelperEnv(scenario),
    },
  )
  expect(output).toContain('"ok":true')
}

async function configureIntegration(scenario: Scenario): Promise<void> {
  const result = runIntakeHelper(scenario, ['configure']) as { ok?: boolean }
  expect(result.ok).toBe(true)
  expect(runIntakeHelper(scenario, ['diagnose'])).toMatchObject({
    enabled: true,
    hasSigningSecret: true,
    encryptionEnabled: true,
    hasDek: true,
    encryptedFields: expect.arrayContaining(['payload_json']),
    rateLimitAllowed: true,
  })
}

function runIntakeHelper(scenario: Scenario, args: string[]): Record<string, unknown> {
  const output = execFileSync(tsxBin, [intakeRunner, ...args], { cwd: appDir, encoding: 'utf8', env: intakeHelperEnv(scenario) })
  const resultLine = output.trim().split(/\r?\n/).find((line) => line.startsWith('FINOO_INTAKE_RESULT '))
  if (resultLine) return JSON.parse(resultLine.slice('FINOO_INTAKE_RESULT '.length)) as Record<string, unknown>
  throw new Error('[internal] FINOO intake helper returned no JSON result')
}

function intakeHelperEnv(scenario: Scenario): NodeJS.ProcessEnv {
  return {
    ...process.env,
    OM_FINOO_APPLICATION_TENANT_ID: scenario.tenantId,
    OM_FINOO_APPLICATION_ORGANIZATION_ID: scenario.organizationId,
    OM_FINOO_TEST_SIGNING_SECRET: signingSecret,
    OM_INTEGRATION_TEST: 'false',
    RATE_LIMIT_ENABLED: 'true',
    RATE_LIMIT_TRUST_PROXY_DEPTH: '1',
    FORCE_COLOR: '0',
    NODE_NO_WARNINGS: '1',
  }
}

async function runIntakeHelperAsync(scenario: Scenario, args: string[]): Promise<Record<string, unknown>> {
  const { stdout } = await execFileAsync(tsxBin, [intakeRunner, ...args], {
    cwd: appDir,
    encoding: 'utf8',
    env: intakeHelperEnv(scenario),
  })
  const resultLine = stdout.trim().split(/\r?\n/).find((line) => line.startsWith('FINOO_INTAKE_RESULT '))
  if (resultLine) return JSON.parse(resultLine.slice('FINOO_INTAKE_RESULT '.length)) as Record<string, unknown>
  throw new Error('[internal] FINOO async intake helper returned no JSON result')
}

async function submit(
  scenario: Scenario,
  payload: Record<string, unknown>,
  messageId: string,
  sourceTimestamp?: number,
): Promise<{ status: number; body: IntakeResponse }> {
  const result = runIntakeHelper(scenario, [
    'submit',
    messageId,
    Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url'),
    ...(sourceTimestamp === undefined ? [] : [String(sourceTimestamp)]),
  ]) as { status: number; body: IntakeResponse }
  return result
}

async function submitAsync(
  scenario: Scenario,
  payload: Record<string, unknown>,
  messageId: string,
): Promise<{ status: number; body: IntakeResponse }> {
  return runIntakeHelperAsync(scenario, [
    'submit',
    messageId,
    Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url'),
  ]) as Promise<{ status: number; body: IntakeResponse }>
}

async function waitForProcessed(intakeId: string): Promise<void> {
  await drainIntegrationQueue('finoo-applications-project')
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const rows = await queryDatabase<{ state: string; last_error_code: string | null }>(
      'select state, last_error_code from finoo_application_intakes where id = $1',
      [intakeId],
    )
    if (rows[0]?.state === 'processed') return
    if (rows[0]?.state === 'failed') throw new Error(`[internal] FINOO projection failed: ${rows[0].last_error_code ?? 'unknown'}`)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
  }
  throw new Error('[internal] Timed out waiting for FINOO projection')
}

async function expectSingleProjectionGraph(scenario: Scenario, leadId: string): Promise<void> {
  const rows = await queryDatabase<{
    projection_count: string
    company_count: string
    person_count: string
    deal_count: string
  }>(
    `select
      (select count(*)::text from finoo_application_projections where tenant_id=$1 and organization_id=$2 and external_lead_id=$3) as projection_count,
      (select count(*)::text from customer_entities ce join finoo_application_projections p on ce.source=concat('finoo_application:', p.id::text)
        where p.tenant_id=$1 and p.organization_id=$2 and p.external_lead_id=$3 and ce.kind='company' and ce.deleted_at is null) as company_count,
      (select count(*)::text from customer_entities ce join finoo_application_projections p on ce.source=concat('finoo_application:', p.id::text)
        where p.tenant_id=$1 and p.organization_id=$2 and p.external_lead_id=$3 and ce.kind='person' and ce.deleted_at is null) as person_count,
      (select count(*)::text from customer_deals cd join finoo_application_projections p on cd.source=concat('finoo_application:', p.id::text)
        where p.tenant_id=$1 and p.organization_id=$2 and p.external_lead_id=$3 and cd.deleted_at is null) as deal_count`,
    [scenario.tenantId, scenario.organizationId, leadId],
  )
  expect(rows).toEqual([{
    projection_count: '1',
    company_count: '1',
    person_count: '1',
    deal_count: '1',
  }])
}

async function cleanupFinooScenario(scenario: Scenario | null): Promise<void> {
  if (!scenario) return
  const values = [scenario.tenantId, scenario.organizationId]
  await queryDatabase('delete from action_logs where tenant_id=$1 and organization_id=$2', values)
  await queryDatabase('delete from finoo_application_consent_evidence where tenant_id=$1 and organization_id=$2', values)
  await queryDatabase('delete from finoo_application_identity_bindings where tenant_id=$1 and organization_id=$2', values)
  await queryDatabase('delete from finoo_application_projections where tenant_id=$1 and organization_id=$2', values)
  await queryDatabase('delete from finoo_application_intakes where tenant_id=$1 and organization_id=$2', values)
  await queryDatabase('delete from custom_field_values where tenant_id=$1 and organization_id=$2', values)
  await queryDatabase('delete from custom_field_defs where tenant_id=$1 and organization_id=$2', values)
  await queryDatabase('delete from integration_credentials where tenant_id=$1 and organization_id=$2', values)
  await queryDatabase('delete from integration_states where tenant_id=$1 and organization_id=$2', values)
  await queryDatabase('delete from encryption_maps where tenant_id=$1 and organization_id=$2', values)
  await queryDatabase('delete from dictionary_entries where tenant_id=$1 and organization_id=$2', values)
  await queryDatabase('delete from dictionaries where tenant_id=$1 and organization_id=$2', values)
}

test('TC-FINOO-APP-001 signed intake projects one encrypted, refreshable CRM graph', async ({ request }) => {
  test.setTimeout(240_000)
  let scenario: Scenario | null = null
  const previousTenantId = process.env.OM_FINOO_APPLICATION_TENANT_ID
  const previousOrganizationId = process.env.OM_FINOO_APPLICATION_ORGANIZATION_ID
  try {
    const routedRequest = await request.post('/api/finoo_applications/intake', {
      data: {},
      headers: { 'x-forwarded-for': '192.0.2.10' },
    })
    expect(routedRequest.status()).toBe(503)
    scenario = await createScenario(request, 'TC-FINOO-APP-001', [
      'customer_accounts.view', 'customer_accounts.manage',
      'customer_accounts.roles.manage', 'customer_accounts.invite',
      'communication_channels.connect_user_channel',
      'customers.people.view', 'customers.people.manage',
      'customers.companies.view', 'customers.companies.manage',
      'customers.deals.view', 'customers.deals.manage',
      'customers.pipelines.view', 'customers.pipelines.manage',
      'entities.definitions.view', 'entities.definitions.manage',
      'dictionaries.view', 'dictionaries.manage',
      'audit_logs.view_self', 'audit_logs.view_tenant',
    ])
    process.env.OM_FINOO_APPLICATION_TENANT_ID = scenario.tenantId
    process.env.OM_FINOO_APPLICATION_ORGANIZATION_ID = scenario.organizationId
    await queryDatabase(
      `update encryption_maps set is_active=false, updated_at=now()
       where tenant_id=$1 and organization_id=$2 and entity_id = any($3::text[])`,
      [scenario.tenantId, scenario.organizationId, [
        'customers:customer_entity',
        'customers:customer_person_profile',
        'customers:customer_company_profile',
        'customers:customer_deal',
        'audit_logs:action_log',
        'finoo_applications:finoo_application_intake',
      ]],
    )
    const backfillActionLogId = randomUUID()
    const deletedBackfillActionLogId = randomUUID()
    await queryDatabase(
      `insert into action_logs
         (id, tenant_id, organization_id, command_id, action_label, execution_state, created_at, updated_at)
       values ($1, $2, $3, $4, $5, 'done', now(), now())`,
      [backfillActionLogId, scenario.tenantId, scenario.organizationId, `finoo-backfill-fixture:${randomUUID()}`, 'FINOO plaintext backfill fixture'],
    )
    await queryDatabase(
      `insert into action_logs
         (id, tenant_id, organization_id, command_id, action_label, execution_state, created_at, updated_at, deleted_at)
       values ($1, $2, $3, $4, $5, 'done', now(), now(), now())`,
      [deletedBackfillActionLogId, scenario.tenantId, scenario.organizationId, `finoo-deleted-backfill:${randomUUID()}`, 'FINOO deleted plaintext backfill fixture'],
    )
    const companyTypeEntryId = await createFieldManifest(request, scenario)
    const deletedCustomFieldValueId = randomUUID()
    await queryDatabase(
      `insert into custom_field_values
         (id, tenant_id, organization_id, entity_id, record_id, field_key, value_text, created_at, deleted_at)
       values ($1, $2, $3, 'customers:customer_deal', $4, 'initial_referrer', $5, now(), now())`,
      [deletedCustomFieldValueId, scenario.tenantId, scenario.organizationId, randomUUID(), 'FINOO deleted custom-field plaintext fixture'],
    )
    await createPipeline(request, scenario)
    prepareEncryption(scenario)
    const backfilledActionLog = await queryDatabase<{ command_id: string; action_label: string }>(
      'select command_id, action_label from action_logs where id=$1',
      [backfillActionLogId],
    )
    expect(backfilledActionLog[0]?.command_id).toMatch(/^[^:]+:[^:]+:[^:]+:v1$/)
    expect(backfilledActionLog[0]?.action_label).toMatch(/^[^:]+:[^:]+:[^:]+:v1$/)
    const deletedBackfilledRows = await queryDatabase<{ value: string }>(
      `select command_id as value from action_logs where id=$1
       union all select value_text as value from custom_field_values where id=$2`,
      [deletedBackfillActionLogId, deletedCustomFieldValueId],
    )
    expect(deletedBackfilledRows).toHaveLength(2)
    expect(deletedBackfilledRows.every((row) => /^[^:]+:[^:]+:[^:]+:v1$/.test(row.value))).toBe(true)
    const preservedCustomerMap = await queryDatabase<{ fields_json: Array<{ field: string }> }>(
      `select fields_json from encryption_maps
       where tenant_id=$1 and organization_id=$2 and entity_id='customers:customer_entity' and deleted_at is null`,
      [scenario.tenantId, scenario.organizationId],
    )
    expect(preservedCustomerMap).toHaveLength(1)
    expect(preservedCustomerMap[0]!.fields_json.map(({ field }) => field)).toEqual(expect.arrayContaining([
      'display_name', 'primary_email', 'primary_phone', 'next_interaction_name', 'description',
    ]))
    const duplicateMapId = randomUUID()
    await queryDatabase(
      `insert into encryption_maps
         (id, tenant_id, organization_id, entity_id, fields_json, is_active, created_at, updated_at)
       values ($1, $2, $3, 'customers:customer_entity', '[{"field":"display_name"}]'::jsonb, true, now(), now())`,
      [duplicateMapId, scenario.tenantId, scenario.organizationId],
    )
    let duplicateMapFailure: unknown
    try {
      execFileSync(process.execPath, [
        cliBin,
        'finoo_applications',
        'prepare-encryption',
        '--tenant', scenario.tenantId,
        '--organization', scenario.organizationId,
        '--dry-run',
      ], {
        cwd: appDir,
        encoding: 'utf8',
        env: { ...process.env, FORCE_COLOR: '0', NODE_NO_WARNINGS: '1' },
      })
    } catch (error) {
      duplicateMapFailure = error
    }
    expect(duplicateMapFailure).toBeTruthy()
    expect(String((duplicateMapFailure as { stderr?: string | Buffer }).stderr)).toContain('Duplicate scoped encryption maps')
    await queryDatabase('delete from encryption_maps where id=$1', [duplicateMapId])
    await configureIntegration(scenario)

    const leadId = `lead_${randomUUID().replace(/-/g, '')}`
    const draftPayload = {
      leadId,
      consentVersion: FINOO_CONSENT_REGISTRY_VERSION,
      completed: false,
      name: 'Alicja',
      surname: 'Draft',
      email: 'alicja-draft@example.invalid',
      mobilePrefix: '+48',
      mobile: '111000000',
      companyName: 'FINOO Draft Company',
      nip: '1234567890',
      pesel: '12345678901',
      businessType: 'company',
      earnings: '50000',
      amount: '100000',
      acceptTerms: true,
      contactConsent: true,
      contactEmail: true,
      contactSms: false,
      contactPhone: false,
      legalConsent: {
        legal1: { selected: true },
        legal2: { selected: true },
      },
      kontomatikToken: 'KONTOMATIK_INTEGRATION_CANARY',
    }
    const draftMessageId = `msg_${randomUUID()}`
    const draft = await submit(scenario, draftPayload, draftMessageId)
    expect(draft.status).toBe(202)
    expect(draft.body.intakeId).toBeTruthy()
    await waitForProcessed(draft.body.intakeId!)

    const rawDraft = await queryDatabase<{ payload_json: string }>(
      'select payload_json::text as payload_json from finoo_application_intakes where id=$1',
      [draft.body.intakeId],
    )
    expect(rawDraft[0]?.payload_json).not.toContain('KONTOMATIK_INTEGRATION_CANARY')
    expect(rawDraft[0]?.payload_json).not.toContain('12345678901')
    expect(rawDraft[0]?.payload_json).not.toContain('1234567890')

    const finalPayload = {
      ...draftPayload,
      completed: true,
      surname: 'Final',
      email: 'alicja-final@example.invalid',
      mobilePrefix: '+48',
      mobile: '222000000',
      traffic_source: 'organic',
      companyName: 'FINOO Final Company',
      nip: '9876543210',
      pesel: '10987654321',
      kontomatikToken: undefined,
    }
    const finalMessageId = `msg_${randomUUID()}`
    const final = await submit(scenario, finalPayload, finalMessageId)
    expect(final.status).toBe(202)
    await waitForProcessed(final.body.intakeId!)

    const duplicate = await submit(scenario, finalPayload, finalMessageId)
    expect(duplicate.status).toBe(200)
    expect(duplicate.body).toMatchObject({ duplicate: true, intakeId: final.body.intakeId })
    const conflict = await submit(scenario, { ...finalPayload, amount: '100001' }, finalMessageId)
    expect(conflict.status).toBe(409)
    const conflictingMessageRows = await queryDatabase<{ count: string }>(
      `select count(*)::text as count from finoo_application_intakes
       where tenant_id=$1 and organization_id=$2 and message_id=$3`,
      [scenario.tenantId, scenario.organizationId, finalMessageId],
    )
    expect(conflictingMessageRows).toEqual([{ count: '1' }])

    const stale = await submit(scenario, {
      ...finalPayload,
      surname: 'Ignored Stale',
    }, `msg_${randomUUID()}`, Math.floor(Date.now() / 1000) - 60)
    expect(stale.status).toBe(202)
    await waitForProcessed(stale.body.intakeId!)
    const staleProjection = await queryDatabase<{ state: string; warnings_json: string[] }>(
      `select state, warnings_json from finoo_application_projections
       where tenant_id=$1 and organization_id=$2 and external_lead_id=$3`,
      [scenario.tenantId, scenario.organizationId, leadId],
    )
    expect(staleProjection[0]).toMatchObject({ state: 'completed' })
    expect(staleProjection[0]?.warnings_json).toContain('stale_submission_ignored')

    const regression = await submit(scenario, {
      ...finalPayload,
      completed: false,
      surname: 'Ignored Regression',
    }, `msg_${randomUUID()}`)
    expect(regression.status).toBe(202)
    await waitForProcessed(regression.body.intakeId!)
    const regressionProjection = await queryDatabase<{ state: string; warnings_json: string[] }>(
      `select state, warnings_json from finoo_application_projections
       where tenant_id=$1 and organization_id=$2 and external_lead_id=$3`,
      [scenario.tenantId, scenario.organizationId, leadId],
    )
    expect(regressionProjection[0]).toMatchObject({ state: 'completed' })
    expect(regressionProjection[0]?.warnings_json).toContain('terminal_draft_ignored')

    const terminalConflict = await submit(scenario, {
      ...finalPayload,
      disqualified: true,
      disqualification_message: 'Ignored terminal conflict',
    }, `msg_${randomUUID()}`)
    expect(terminalConflict.status).toBe(202)
    await waitForProcessed(terminalConflict.body.intakeId!)
    const terminalConflictProjection = await queryDatabase<{ state: string; warnings_json: string[] }>(
      `select state, warnings_json from finoo_application_projections
       where tenant_id=$1 and organization_id=$2 and external_lead_id=$3`,
      [scenario.tenantId, scenario.organizationId, leadId],
    )
    expect(terminalConflictProjection[0]).toMatchObject({ state: 'completed' })
    expect(terminalConflictProjection[0]?.warnings_json).toContain('terminal_state_conflict')

    const graph = await queryDatabase<{
      companies: string
      people: string
      deals: string
      company_entity_id: string
      person_entity_id: string
      deal_id: string
      raw_values: string
      stage: string
    }>(
      `select
         (select count(*)::text from customer_entities where tenant_id=$1 and organization_id=$2 and kind='company' and deleted_at is null) as companies,
         (select count(*)::text from customer_entities where tenant_id=$1 and organization_id=$2 and kind='person' and deleted_at is null) as people,
         (select count(*)::text from customer_deals where tenant_id=$1 and organization_id=$2 and deleted_at is null) as deals,
         (select id::text from customer_entities where tenant_id=$1 and organization_id=$2 and kind='company' and deleted_at is null limit 1) as company_entity_id,
         (select id::text from customer_entities where tenant_id=$1 and organization_id=$2 and kind='person' and deleted_at is null limit 1) as person_entity_id,
         (select id::text from customer_deals where tenant_id=$1 and organization_id=$2 and deleted_at is null limit 1) as deal_id,
         concat_ws('|',
           (select display_name from customer_entities where tenant_id=$1 and organization_id=$2 and kind='company' and deleted_at is null limit 1),
           (select display_name from customer_entities where tenant_id=$1 and organization_id=$2 and kind='person' and deleted_at is null limit 1),
           (select primary_email from customer_entities where tenant_id=$1 and organization_id=$2 and kind='person' and deleted_at is null limit 1),
           (select primary_phone from customer_entities where tenant_id=$1 and organization_id=$2 and kind='person' and deleted_at is null limit 1),
           (select legal_name from customer_companies where tenant_id=$1 and organization_id=$2 limit 1),
           (select first_name from customer_people where tenant_id=$1 and organization_id=$2 limit 1),
           (select last_name from customer_people where tenant_id=$1 and organization_id=$2 limit 1),
           (select title from customer_deals where tenant_id=$1 and organization_id=$2 and deleted_at is null limit 1),
           (select description from customer_deals where tenant_id=$1 and organization_id=$2 and deleted_at is null limit 1)
         ) as raw_values,
         (select cps.name from customer_deals cd join customer_pipeline_stages cps on cps.id=cd.pipeline_stage_id where cd.tenant_id=$1 and cd.organization_id=$2 limit 1) as stage`,
      [scenario.tenantId, scenario.organizationId],
    )
    expect(graph[0]).toMatchObject({
      companies: '1',
      people: '1',
      deals: '1',
      stage: 'Submitted',
    })
    for (const canary of [
      'FINOO Final Company',
      'Alicja',
      'Final',
      'alicja-final@example.invalid',
      '+48222000000',
    ]) {
      expect(graph[0]?.raw_values).not.toContain(canary)
    }

    const companyResponse = await scopedApiRequest(
      request,
      scenario,
      'GET',
      `/api/customers/companies/${graph[0]?.company_entity_id}`,
    )
    expect(companyResponse.status()).toBe(200)
    expect(await companyResponse.json()).toMatchObject({
      company: { displayName: 'FINOO Final Company' },
      profile: { legalName: 'FINOO Final Company' },
    })
    const personResponse = await scopedApiRequest(
      request,
      scenario,
      'GET',
      `/api/customers/people/${graph[0]?.person_entity_id}`,
    )
    expect(personResponse.status()).toBe(200)
    expect(await personResponse.json()).toMatchObject({
      person: {
        displayName: 'Alicja Final',
        primaryEmail: 'alicja-final@example.invalid',
        primaryPhone: '+48222000000',
      },
      profile: { firstName: 'Alicja', lastName: 'Final' },
    })
    const dealResponse = await scopedApiRequest(
      request,
      scenario,
      'GET',
      `/api/customers/deals/${graph[0]?.deal_id}`,
    )
    expect(dealResponse.status()).toBe(200)
    const dealPayload = await dealResponse.json() as { deal?: Record<string, unknown>; customFields?: Record<string, unknown> }
    expect(dealPayload).toMatchObject({
      deal: { title: 'FINOO Final Company', pipelineStage: 'Submitted' },
      customFields: { traffic_source: 'organic', earnings: 50000, turnover: 50000 },
    })

    const bindings = await queryDatabase<{ identity_kind: string; customer_entity_id: string | null }>(
      `select identity_kind, customer_entity_id from finoo_application_identity_bindings
       where tenant_id=$1 and organization_id=$2 order by identity_kind, created_at`,
      [scenario.tenantId, scenario.organizationId],
    )
    expect(bindings).toHaveLength(6)
    expect(bindings.every((binding) => Boolean(binding.customer_entity_id))).toBe(true)

    const companyType = await queryDatabase<{ value_text: string | null }>(
      `select cfv.value_text from custom_field_values cfv
       where cfv.tenant_id=$1 and cfv.organization_id=$2
         and cfv.entity_id='customers:customer_company_profile' and cfv.field_key='company_type'`,
      [scenario.tenantId, scenario.organizationId],
    )
    expect(companyType).toEqual([{ value_text: companyTypeEntryId }])

    const sensitiveRows = await queryDatabase<{ stored: string }>(
      `select concat_ws('|', value_text, value_multiline, value_int::text, value_bool::text) as stored
       from custom_field_values where tenant_id=$1 and organization_id=$2`,
      [scenario.tenantId, scenario.organizationId],
    )
    const rawCustomFields = JSON.stringify(sensitiveRows)
    expect(rawCustomFields).not.toContain('9876543210')
    expect(rawCustomFields).not.toContain('10987654321')
    expect(rawCustomFields).not.toContain('+48222000000')

    const actionLogRows = await queryDatabase<{ stored: string }>(
      `select concat_ws('|', command_payload::text, snapshot_before::text, snapshot_after::text,
         changes_json::text, context_json::text) as stored
       from action_logs where tenant_id=$1 and organization_id=$2`,
      [scenario.tenantId, scenario.organizationId],
    )
    expect(actionLogRows.length).toBeGreaterThan(0)
    const rawActionLogs = JSON.stringify(actionLogRows)
    for (const canary of ['FINOO Final Company', 'Alicja', 'Final', 'alicja-final@example.invalid', '+48222000000']) {
      expect(rawActionLogs).not.toContain(canary)
    }
    const actionLogResponse = await scopedApiRequest(
      request,
      scenario,
      'GET',
      `/api/audit_logs/audit-logs/actions?organizationId=${encodeURIComponent(scenario.organizationId)}&pageSize=100`,
    )
    expect(actionLogResponse.status()).toBe(200)
    const decryptedActionLogs = await actionLogResponse.json() as { items?: Array<Record<string, unknown>> }
    expect(decryptedActionLogs.items?.length).toBeGreaterThan(0)
    expect(JSON.stringify(decryptedActionLogs.items)).toContain('FINOO Final Company')

    const evidence = await queryDatabase<{ count: string; distinct_intakes: string }>(
      `select count(*)::text as count, count(distinct intake_id)::text as distinct_intakes
       from finoo_application_consent_evidence where tenant_id=$1 and organization_id=$2`,
      [scenario.tenantId, scenario.organizationId],
    )
    expect(evidence[0]).toMatchObject({ count: '35', distinct_intakes: '5' })

    const rejectedLeadId = `rejected_${randomUUID().replace(/-/g, '')}`
    const rejected = await submit(scenario, {
      ...finalPayload,
      leadId: rejectedLeadId,
      email: 'rejected@example.invalid',
      nip: '5555555555',
      pesel: '55555555555',
      companyName: 'FINOO Rejected Company',
      disqualified: true,
      disqualification_message: 'Synthetic automatic rejection',
    }, `msg_${randomUUID()}`)
    expect(rejected.status).toBe(202)
    await waitForProcessed(rejected.body.intakeId!)
    const rejectedProjection = await queryDatabase<{ state: string; stage: string; deal_status: string }>(
      `select fap.state, cps.name as stage, cd.status as deal_status
       from finoo_application_projections fap
       join customer_deals cd on cd.id=fap.deal_id
       join customer_pipeline_stages cps on cps.id=cd.pipeline_stage_id
       where fap.tenant_id=$1 and fap.organization_id=$2 and fap.external_lead_id=$3`,
      [scenario.tenantId, scenario.organizationId, rejectedLeadId],
    )
    expect(rejectedProjection).toEqual([{ state: 'disqualified', stage: 'Closed', deal_status: 'closed' }])

    const existingPersonEmail = `existing-${randomUUID()}@example.invalid`
    const existingPersonId = await createUnownedPerson(request, scenario, existingPersonEmail)
    await insertIdentityBinding(scenario, 'email', existingPersonEmail, null, existingPersonId)
    const unrelatedPersonLeadId = `unrelated_person_${randomUUID().replace(/-/g, '')}`
    const unrelatedPerson = await submit(scenario, {
      ...finalPayload,
      leadId: unrelatedPersonLeadId,
      email: existingPersonEmail,
      pesel: undefined,
      nip: '4444444444',
      companyName: 'FINOO Unrelated Person Company',
      name: 'Attempted',
      surname: 'Overwrite',
    }, `msg_${randomUUID()}`)
    expect(unrelatedPerson.status).toBe(202)
    await waitForProcessed(unrelatedPerson.body.intakeId!)
    const unrelatedPersonProjection = await queryDatabase<{
      applicant_entity_id: string | null
      deal_id: string | null
      last_error_code: string | null
    }>(
      `select applicant_entity_id, deal_id, last_error_code from finoo_application_projections
       where tenant_id=$1 and organization_id=$2 and external_lead_id=$3`,
      [scenario.tenantId, scenario.organizationId, unrelatedPersonLeadId],
    )
    expect(unrelatedPersonProjection).toEqual([{
      applicant_entity_id: null,
      deal_id: null,
      last_error_code: 'applicant_identity_requires_review',
    }])
    const existingPersonResponse = await scopedApiRequest(request, scenario, 'GET', `/api/customers/people/${existingPersonId}`)
    expect(existingPersonResponse.status()).toBe(200)
    expect(await existingPersonResponse.json()).toMatchObject({
      person: { displayName: 'Existing Person', primaryEmail: existingPersonEmail },
      profile: { firstName: 'Existing', lastName: 'Person' },
    })

    const foreignEmail = `foreign-${randomUUID()}@example.invalid`
    await insertIdentityBinding(scenario, 'email', foreignEmail, randomUUID(), null)
    const foreignLeadId = `foreign_binding_${randomUUID().replace(/-/g, '')}`
    const foreignBinding = await submit(scenario, {
      ...finalPayload,
      leadId: foreignLeadId,
      email: foreignEmail,
      pesel: undefined,
      nip: '3333333333',
      companyName: 'FINOO Foreign Binding Company',
    }, `msg_${randomUUID()}`)
    expect(foreignBinding.status).toBe(202)
    await waitForProcessed(foreignBinding.body.intakeId!)
    const foreignBindingRows = await queryDatabase<{ projection_id: string | null; customer_entity_id: string | null }>(
      `select projection_id, customer_entity_id from finoo_application_identity_bindings
       where tenant_id=$1 and organization_id=$2 and identity_kind='email' and identity_hash=$3`,
      [
        scenario.tenantId,
        scenario.organizationId,
        hashForLookup(foreignEmail, `finoo_application:${scenario.tenantId}:${scenario.organizationId}:email`),
      ],
    )
    expect(foreignBindingRows).toHaveLength(1)
    expect(foreignBindingRows[0]?.customer_entity_id).toBeNull()

    const existingCompanyId = await createUnownedCompany(request, scenario, 'Existing Company')
    await insertIdentityBinding(scenario, 'nip', '2222222222', null, existingCompanyId)
    const unrelatedCompanyLeadId = `unrelated_company_${randomUUID().replace(/-/g, '')}`
    const unrelatedCompanyPayload = {
      ...finalPayload,
      leadId: unrelatedCompanyLeadId,
      email: `company-owner-${randomUUID()}@example.invalid`,
      pesel: undefined,
      nip: '2222222222',
      companyName: 'Attempted Existing Company Overwrite',
    }
    const unrelatedCompany = await submit(scenario, unrelatedCompanyPayload, `msg_${randomUUID()}`)
    expect(unrelatedCompany.status).toBe(202)
    await waitForProcessed(unrelatedCompany.body.intakeId!)
    const changedNip = await submit(scenario, {
      ...unrelatedCompanyPayload,
      nip: '1111111111',
      companyName: 'Attempted Second Company Overwrite',
    }, `msg_${randomUUID()}`)
    expect(changedNip.status).toBe(202)
    await waitForProcessed(changedNip.body.intakeId!)
    const existingCompanyResponse = await scopedApiRequest(request, scenario, 'GET', `/api/customers/companies/${existingCompanyId}`)
    expect(existingCompanyResponse.status()).toBe(200)
    expect(await existingCompanyResponse.json()).toMatchObject({
      company: { displayName: 'Existing Company' },
    })
    const changedNipBinding = await queryDatabase<{ customer_entity_id: string | null }>(
      `select customer_entity_id from finoo_application_identity_bindings
       where tenant_id=$1 and organization_id=$2 and identity_kind='nip' and identity_hash=$3`,
      [
        scenario.tenantId,
        scenario.organizationId,
        hashForLookup('1111111111', `finoo_application:${scenario.tenantId}:${scenario.organizationId}:nip`),
      ],
    )
    expect(changedNipBinding).toEqual([{ customer_entity_id: null }])

    const representativeRecoveryLeadId = `representative_recovery_${randomUUID().replace(/-/g, '')}`
    const representativeRecoveryPayload = {
      ...draftPayload,
      leadId: representativeRecoveryLeadId,
      email: `recovery-applicant-${randomUUID()}@example.invalid`,
      nip: '1212121212',
      pesel: undefined,
      companyName: 'FINOO Representative Recovery Company',
    }
    const representativeRecoveryDraft = await submit(
      scenario,
      representativeRecoveryPayload,
      `msg_${randomUUID()}`,
    )
    expect(representativeRecoveryDraft.status).toBe(202)
    await waitForProcessed(representativeRecoveryDraft.body.intakeId!)
    const representativeRecoveryProjection = await queryDatabase<{ id: string; company_entity_id: string }>(
      `select id::text, company_entity_id::text from finoo_application_projections
       where tenant_id=$1 and organization_id=$2 and external_lead_id=$3`,
      [scenario.tenantId, scenario.organizationId, representativeRecoveryLeadId],
    )
    const recoveryProjectionId = representativeRecoveryProjection[0]!.id
    const recoveryCompanyId = representativeRecoveryProjection[0]!.company_entity_id
    const recoveryRepresentativeEmail = `recovered-representative-${randomUUID()}@example.invalid`
    const recoveryRepresentativeId = await createUnownedPerson(
      request,
      scenario,
      recoveryRepresentativeEmail,
      {
        firstName: 'Partial',
        lastName: 'Core',
        source: `finoo_application:${recoveryProjectionId}`,
        companyEntityId: recoveryCompanyId,
      },
    )
    await insertIdentityBinding(
      scenario,
      'email',
      recoveryRepresentativeEmail,
      recoveryProjectionId,
      null,
      recoveryRepresentativeId,
    )
    const representativeRecoveryFinal = await submit(scenario, {
      ...representativeRecoveryPayload,
      completed: true,
      representatives: [{
        firstname: 'Recovered',
        lastname: 'Representative',
        email: recoveryRepresentativeEmail,
      }],
    }, `msg_${randomUUID()}`)
    expect(representativeRecoveryFinal.status).toBe(202)
    await waitForProcessed(representativeRecoveryFinal.body.intakeId!)
    const recoveredBinding = await queryDatabase<{ customer_entity_id: string | null }>(
      `select customer_entity_id::text from finoo_application_identity_bindings
       where tenant_id=$1 and organization_id=$2 and projection_id=$3 and identity_kind='email'
         and identity_hash=$4`,
      [
        scenario.tenantId,
        scenario.organizationId,
        recoveryProjectionId,
        hashForLookup(
          recoveryRepresentativeEmail,
          `finoo_application:${scenario.tenantId}:${scenario.organizationId}:email`,
        ),
      ],
    )
    expect(recoveredBinding).toEqual([{ customer_entity_id: recoveryRepresentativeId }])
    const recoveredRepresentativeResponse = await scopedApiRequest(
      request,
      scenario,
      'GET',
      `/api/customers/people/${recoveryRepresentativeId}`,
    )
    expect(recoveredRepresentativeResponse.status()).toBe(200)
    expect(await recoveredRepresentativeResponse.json()).toMatchObject({
      person: {
        displayName: 'Recovered Representative',
        primaryEmail: recoveryRepresentativeEmail,
      },
      profile: {
        firstName: 'Recovered',
        lastName: 'Representative',
        companyEntityId: recoveryCompanyId,
      },
    })

    const concurrentLeadId = `concurrent_${randomUUID().replace(/-/g, '')}`
    const concurrentBase = {
      ...finalPayload,
      leadId: concurrentLeadId,
      pesel: undefined,
      companyName: 'FINOO Concurrent Company',
    }
    const [concurrentA, concurrentB] = await Promise.all([
      submitAsync(scenario, {
        ...concurrentBase,
        email: `concurrent-a-${randomUUID()}@example.invalid`,
        nip: '7777777777',
      }, `msg_${randomUUID()}`),
      submitAsync(scenario, {
        ...concurrentBase,
        email: `concurrent-b-${randomUUID()}@example.invalid`,
        nip: '8888888888',
      }, `msg_${randomUUID()}`),
    ])
    expect(concurrentA.status).toBe(202)
    expect(concurrentB.status).toBe(202)
    await waitForProcessed(concurrentA.body.intakeId!)
    await waitForProcessed(concurrentB.body.intakeId!)
    const concurrentGraph = await queryDatabase<{
      projection_count: string
      company_count: string
      person_count: string
      deal_count: string
    }>(
      `select
        (select count(*)::text from finoo_application_projections where tenant_id=$1 and organization_id=$2 and external_lead_id=$3) as projection_count,
        (select count(*)::text from customer_entities ce join finoo_application_projections p on ce.source=concat('finoo_application:', p.id::text)
          where p.tenant_id=$1 and p.organization_id=$2 and p.external_lead_id=$3 and ce.kind='company' and ce.deleted_at is null) as company_count,
        (select count(*)::text from customer_entities ce join finoo_application_projections p on ce.source=concat('finoo_application:', p.id::text)
          where p.tenant_id=$1 and p.organization_id=$2 and p.external_lead_id=$3 and ce.kind='person' and ce.deleted_at is null) as person_count,
        (select count(*)::text from customer_deals cd join finoo_application_projections p on cd.source=concat('finoo_application:', p.id::text)
          where p.tenant_id=$1 and p.organization_id=$2 and p.external_lead_id=$3 and cd.deleted_at is null) as deal_count`,
      [scenario.tenantId, scenario.organizationId, concurrentLeadId],
    )
    expect(concurrentGraph).toEqual([{
      projection_count: '1',
      company_count: '1',
      person_count: '1',
      deal_count: '1',
    }])

    for (const phase of [
      { kind: 'company', nip: '1313131313', customEntityId: 'customers:customer_company_profile', customFieldKey: 'tax_number' },
      { kind: 'person', nip: '1414141414', customEntityId: 'customers:customer_person_profile', customFieldKey: 'mobile' },
      { kind: 'deal', nip: '1515151515', customEntityId: 'customers:customer_deal', customFieldKey: 'external_id' },
    ]) {
      const recoveryLeadId = `phase_recovery_${randomUUID().replace(/-/g, '')}`
      const phasePayload = {
        ...finalPayload,
        leadId: recoveryLeadId,
        email: `phase-recovery-${randomUUID()}@example.invalid`,
        pesel: undefined,
        nip: phase.nip,
        companyName: `FINOO ${phase.kind} Recovery`,
      }
      const phaseInitial = await submit(scenario, phasePayload, `msg_${randomUUID()}`)
      expect(phaseInitial.status).toBe(202)
      await waitForProcessed(phaseInitial.body.intakeId!)
      const phaseProjection = await queryDatabase<{
        id: string
        company_entity_id: string
        applicant_entity_id: string
        deal_id: string
      }>(
        `select id::text, company_entity_id::text, applicant_entity_id::text, deal_id::text
         from finoo_application_projections
         where tenant_id=$1 and organization_id=$2 and external_lead_id=$3`,
        [scenario.tenantId, scenario.organizationId, recoveryLeadId],
      )
      const originalProjection = phaseProjection[0]!
      const coreEntityId = phase.kind === 'company'
        ? originalProjection.company_entity_id
        : phase.kind === 'person'
          ? originalProjection.applicant_entity_id
          : originalProjection.deal_id
      const customRecord = phase.kind === 'company'
        ? await queryDatabase<{ id: string }>('select id::text from customer_companies where entity_id=$1', [coreEntityId])
        : phase.kind === 'person'
          ? await queryDatabase<{ id: string }>('select id::text from customer_people where entity_id=$1', [coreEntityId])
          : [{ id: coreEntityId }]
      const customRecordId = customRecord[0]!.id
      await queryDatabase(
        `delete from custom_field_values where tenant_id=$1 and organization_id=$2
           and entity_id=$3 and record_id=$4`,
        [scenario.tenantId, scenario.organizationId, phase.customEntityId, customRecordId],
      )
      await queryDatabase(
        'delete from action_logs where tenant_id=$1 and organization_id=$2 and resource_id=$3',
        [scenario.tenantId, scenario.organizationId, coreEntityId],
      )
      if (phase.kind === 'company') {
        await queryDatabase(
          'update finoo_application_projections set company_entity_id=null where id=$1',
          [originalProjection.id],
        )
        await queryDatabase(
          `update finoo_application_identity_bindings set customer_entity_id=null
           where tenant_id=$1 and organization_id=$2 and projection_id=$3 and identity_kind='nip'`,
          [scenario.tenantId, scenario.organizationId, originalProjection.id],
        )
      } else if (phase.kind === 'person') {
        await queryDatabase(
          'update finoo_application_projections set applicant_entity_id=null where id=$1',
          [originalProjection.id],
        )
        await queryDatabase(
          `update finoo_application_identity_bindings set customer_entity_id=null
           where tenant_id=$1 and organization_id=$2 and projection_id=$3 and identity_kind in ('pesel', 'email')
             and customer_entity_id=$4`,
          [scenario.tenantId, scenario.organizationId, originalProjection.id, coreEntityId],
        )
      }
      const phaseRefresh = await submit(scenario, {
        ...phasePayload,
        companyName: `FINOO ${phase.kind} Refreshed`,
        surname: 'Recovery',
      }, `msg_${randomUUID()}`)
      expect(phaseRefresh.status).toBe(202)
      await waitForProcessed(phaseRefresh.body.intakeId!)
      await expectSingleProjectionGraph(scenario, recoveryLeadId)
      const recoveredProjection = await queryDatabase<{
        company_entity_id: string
        applicant_entity_id: string
        deal_id: string
      }>(
        `select company_entity_id::text, applicant_entity_id::text, deal_id::text
         from finoo_application_projections where id=$1`,
        [originalProjection.id],
      )
      expect(recoveredProjection).toEqual([{
        company_entity_id: originalProjection.company_entity_id,
        applicant_entity_id: originalProjection.applicant_entity_id,
        deal_id: originalProjection.deal_id,
      }])
      const recoveredSideEffects = await queryDatabase<{ custom_fields: string; audit_events: string }>(
        `select
          (select count(*)::text from custom_field_values where tenant_id=$1 and organization_id=$2
            and entity_id=$3 and record_id=$4 and field_key=$5) as custom_fields,
          (select count(*)::text from action_logs where tenant_id=$1 and organization_id=$2
            and resource_id=$6) as audit_events`,
        [
          scenario.tenantId,
          scenario.organizationId,
          phase.customEntityId,
          customRecordId,
          phase.customFieldKey,
          coreEntityId,
        ],
      )
      expect(Number(recoveredSideEffects[0]?.custom_fields)).toBeGreaterThan(0)
      expect(Number(recoveredSideEffects[0]?.audit_events)).toBeGreaterThan(0)
    }

    const unavailableAffiliateLeadId = `affiliate_unavailable_${randomUUID().replace(/-/g, '')}`
    const unavailableAffiliateSubmission = await submit(scenario, {
      ...finalPayload,
      leadId: unavailableAffiliateLeadId,
      email: `affiliate-unavailable-${randomUUID()}@example.invalid`,
      pesel: undefined,
      nip: '1616161616',
      companyName: 'FINOO Affiliate Unavailable',
      affiliate_code: `UNAVAILABLE-${randomUUID()}`,
    }, `msg_${randomUUID()}`)
    expect(unavailableAffiliateSubmission.status).toBe(202)
    expect(runIntakeHelper(scenario, [
      'project-without-affiliate',
      unavailableAffiliateSubmission.body.intakeId!,
    ])).toMatchObject({ ok: true })
    await waitForProcessed(unavailableAffiliateSubmission.body.intakeId!)
    const unavailableAffiliateProjection = await queryDatabase<{ warnings_json: string[] }>(
      `select warnings_json from finoo_application_projections
       where tenant_id=$1 and organization_id=$2 and external_lead_id=$3`,
      [scenario.tenantId, scenario.organizationId, unavailableAffiliateLeadId],
    )
    expect(unavailableAffiliateProjection[0]?.warnings_json).toContain('affiliate_module_unavailable')

    const retryLeadId = `retry_${randomUUID().replace(/-/g, '')}`
    const retryPayload = {
      ...finalPayload,
      leadId: retryLeadId,
      email: `retry-${randomUUID()}@example.invalid`,
      pesel: undefined,
      nip: '6666666666',
      companyName: 'FINOO Retry Company',
      position: 'retry_job_position',
      affiliate_code: `UNKNOWN-${randomUUID()}`,
      tenantId: randomUUID(),
      organizationId: randomUUID(),
    }
    const retrySubmission = await submit(scenario, retryPayload, `msg_${randomUUID()}`)
    expect(retrySubmission.status).toBe(202)
    const firstAttempt = runIntakeHelper(scenario, ['project-once', retrySubmission.body.intakeId!])
    expect(firstAttempt).toMatchObject({ ok: false, error: 'dictionary_definition_missing_job_position' })
    const retryingIntake = await queryDatabase<{ state: string; attempt_count: number; last_error_code: string | null }>(
      `select state, attempt_count, last_error_code from finoo_application_intakes where id=$1`,
      [retrySubmission.body.intakeId],
    )
    expect(retryingIntake[0]).toMatchObject({
      state: 'retrying',
      last_error_code: 'dictionary_definition_missing_job_position',
    })
    expect(retryingIntake[0]?.attempt_count).toBeGreaterThanOrEqual(1)
    expect(retryingIntake[0]?.attempt_count).toBeLessThan(5)

    const jobPositionDictionaryId = await createDictionaryFixture(request, scenario.token, {
      key: `finoo_job_position_${randomUUID().slice(0, 8)}`,
      name: 'FINOO job positions',
    })
    await createDictionaryEntry(request, scenario, jobPositionDictionaryId, 'retry_job_position')
    await createFieldDefinition(request, scenario, {
      entityId: 'customers:customer_person_profile',
      key: 'job_position',
      kind: 'dictionary',
      configJson: { label: 'job_position', dictionaryId: jobPositionDictionaryId },
    })
    replayIntake(scenario, retrySubmission.body.intakeId!)
    expect(runIntakeHelper(scenario, ['reconcile'])).toMatchObject({ ok: true })
    await waitForProcessed(retrySubmission.body.intakeId!)
    const replayedProjection = await queryDatabase<{ state: string; warnings_json: string[] }>(
      `select state, warnings_json from finoo_application_projections
       where tenant_id=$1 and organization_id=$2 and external_lead_id=$3`,
      [scenario.tenantId, scenario.organizationId, retryLeadId],
    )
    expect(replayedProjection[0]).toMatchObject({ state: 'completed' })
    expect(replayedProjection[0]?.warnings_json).toContain('unknown_affiliate_code')
    const crossScopeRows = await queryDatabase<{ count: string }>(
      `select count(*)::text as count from finoo_application_intakes
       where id=$1 and tenant_id=$2 and organization_id=$3`,
      [retrySubmission.body.intakeId, scenario.tenantId, scenario.organizationId],
    )
    expect(crossScopeRows).toEqual([{ count: '1' }])

    await queryDatabase(
      `update finoo_application_intakes set processed_at=now() - interval '31 days' where id=$1`,
      [retrySubmission.body.intakeId],
    )
    await queryDatabase(
      `update finoo_application_intakes set state='failed', processed_at=null,
         updated_at=now() - interval '91 days' where id=$1`,
      [rejected.body.intakeId],
    )
    expect(runIntakeHelper(scenario, ['reconcile'])).toMatchObject({ ok: true })
    const retainedPayloads = await queryDatabase<{ id: string; payload_json: string | null }>(
      `select id::text, payload_json::text as payload_json
       from finoo_application_intakes where id in ($1, $2) order by id`,
      [retrySubmission.body.intakeId, rejected.body.intakeId],
    )
    expect(retainedPayloads).toHaveLength(2)
    expect(retainedPayloads.every((row) => row.payload_json !== null)).toBe(true)

    const encryptedIdentityRow = await queryDatabase<{ id: string }>(
      `select id::text from custom_field_values
       where tenant_id=$1 and organization_id=$2
         and entity_id='customers:customer_company_profile' and field_key='tax_number'
       limit 1`,
      [scenario.tenantId, scenario.organizationId],
    )
    expect(encryptedIdentityRow[0]?.id).toBeTruthy()
    await queryDatabase(
      `update custom_field_values set value_text='corrupt:ciphertext:envelope:v1', value_multiline=null,
         value_int=null, value_float=null, value_bool=null where id=$1`,
      [encryptedIdentityRow[0]!.id],
    )
    let corruptCiphertextFailure: unknown
    try {
      execFileSync(process.execPath, [
        cliBin,
        'finoo_applications',
        'prepare-encryption',
        '--tenant', scenario.tenantId,
        '--organization', scenario.organizationId,
        '--dry-run',
      ], {
        cwd: appDir,
        encoding: 'utf8',
        env: { ...process.env, FORCE_COLOR: '0', NODE_NO_WARNINGS: '1' },
      })
    } catch (error) {
      corruptCiphertextFailure = error
    }
    expect(corruptCiphertextFailure).toBeTruthy()
    expect(String((corruptCiphertextFailure as { stderr?: string | Buffer }).stderr)).toContain(
      'Existing FINOO custom-field ciphertext failed authentication',
    )
  } finally {
    try {
      await cleanupFinooScenario(scenario)
      await cleanupScenario(request, scenario)
    } finally {
      if (previousTenantId === undefined) delete process.env.OM_FINOO_APPLICATION_TENANT_ID
      else process.env.OM_FINOO_APPLICATION_TENANT_ID = previousTenantId
      if (previousOrganizationId === undefined) delete process.env.OM_FINOO_APPLICATION_ORGANIZATION_ID
      else process.env.OM_FINOO_APPLICATION_ORGANIZATION_ID = previousOrganizationId
    }
  }
})
