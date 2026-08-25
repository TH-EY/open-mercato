import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type APIRequestContext } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { OPTIMISTIC_LOCK_HEADER_NAME } from '@open-mercato/shared/lib/crud/optimistic-lock-headers'
import {
  createRoleFixture,
  createUserFixture,
  setRoleAclFeatures,
} from '@open-mercato/core/helpers/integration/authFixtures'
import {
  cleanupScenario,
  createScenario,
  queryDatabase,
  scopedApiRequest,
  type Scenario,
} from '../../finoo_intermediaries/__integration__/helpers'
import { FINOO_IOD_ROLE } from '../setup'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', '..')
const appDir = join(repoRoot, 'apps', 'mercato')
const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx')
const setupRunner = join(dirname(fileURLToPath(import.meta.url)), 'setup-runner.ts')

const identityInput = {
  pesel: '44051401458',
  documentType: 'identity_card',
  issuingCountryCode: 'PL',
  documentNumber: 'ABC123456',
  issuedOn: '2024-01-10',
  expiresOn: '2034-01-10',
}

type Actor = Pick<Scenario, 'organizationId'> & { token: string
  userId: string
}

function provisionIodRole(scenario: Scenario): void {
  const output = execFileSync(tsxBin, [setupRunner], {
    cwd: appDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      OM_FINOO_IDENTITY_TENANT_ID: scenario.tenantId,
      OM_FINOO_IDENTITY_ORGANIZATION_ID: scenario.organizationId,
      FORCE_COLOR: '0',
      NODE_NO_WARNINGS: '1',
    },
  })
  expect(output).toContain('FINOO_IDENTITY_SETUP_RESULT {"ok":true}')
}

async function createActor(
  request: APIRequestContext,
  scenario: Scenario,
  roleId: string,
  label: string,
): Promise<Actor> {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12)
  const email = `${label}-${suffix}@test.local`
  const password = `Aa1!${suffix}`
  const userId = await createUserFixture(request, scenario.superToken, {
    email,
    password,
    organizationId: scenario.organizationId,
    roles: [roleId],
    name: `${label} actor`,
  })
  return {
    token: await getAuthToken(request, email, password),
    organizationId: scenario.organizationId,
    userId,
  }
}

test('TC-FINOO-ID-001-005 enforces status-only, IOD, and superadmin identity access', async ({ request }) => {
  test.setTimeout(180_000)
  let scenario: Scenario | null = null
  try {
    scenario = await createScenario(request, 'TC-FINOO-ID-001-005', [
      'customer_accounts.view',
      'customer_accounts.manage',
      'customer_accounts.roles.manage',
      'communication_channels.connect_user_channel',
      'customers.people.view',
      'customers.people.manage',
    ])
    const personResponse = await scopedApiRequest(request, scenario, 'POST', '/api/customers/people', {
      firstName: 'Identity',
      lastName: 'Subject',
      displayName: 'Identity Subject',
      primaryEmail: `identity-subject-${randomUUID()}@test.local`,
    })
    expect(personResponse.status()).toBe(201)
    const personBody = (await personResponse.json()) as { id?: string
      entityId?: string }
    const personId = personBody.id ?? personBody.entityId
    expect(personId).toBeTruthy()

    provisionIodRole(scenario)
    const iodRoles = await queryDatabase<{
      id: string
      features_json: string[] | null
      is_super_admin: boolean | null
    }>(
      `select r.id, ra.features_json, ra.is_super_admin
       from roles r
       left join role_acls ra on ra.role_id = r.id and ra.deleted_at is null
       where r.tenant_id = $1 and r.name = $2 and r.deleted_at is null`,
      [scenario.tenantId, FINOO_IOD_ROLE],
    )
    expect(iodRoles).toHaveLength(1)
    expect(iodRoles[0]).toMatchObject({
      features_json: [
        'customers.people.view',
        'finoo_identities.view',
        'finoo_identities.manage',
      ],
      is_super_admin: false,
    })
    const iodAssignments = await queryDatabase<{ count: string }>(
      `select count(*)::text as count
       from user_roles ur
       where ur.role_id = $1`,
      [iodRoles[0]!.id],
    )
    expect(iodAssignments).toEqual([{ count: '0' }])

    const ordinaryRoleId = await createRoleFixture(request, scenario.superToken, {
      name: `Identity ordinary ${randomUUID().slice(0, 8)}`,
      tenantId: scenario.tenantId,
    })
    await setRoleAclFeatures(request, scenario.superToken, {
      roleId: ordinaryRoleId,
      features: ['customers.people.view'],
      organizations: [scenario.organizationId],
    })
    const ordinary = await createActor(request, scenario, ordinaryRoleId, 'identity-ordinary')
    const iod = await createActor(request, scenario, iodRoles[0]!.id, 'identity-iod')

    const ordinaryManagerRoleId = await createRoleFixture(request, scenario.superToken, {
      name: `Identity ordinary manager ${randomUUID().slice(0, 8)}`,
      tenantId: scenario.tenantId,
    })
    await setRoleAclFeatures(request, scenario.superToken, {
      roleId: ordinaryManagerRoleId,
      features: ['customers.people.view', 'customers.people.manage', 'audit_logs.view_self', 'audit_logs.undo_self'],
      organizations: [scenario.organizationId],
    })
    const ordinaryManager = await createActor(request, scenario, ordinaryManagerRoleId, 'identity-ordinary-manager')

    const superRoleId = await createRoleFixture(request, scenario.superToken, {
      name: `Identity superadmin ${randomUUID().slice(0, 8)}`,
      tenantId: scenario.tenantId,
    })
    await setRoleAclFeatures(request, scenario.superToken, {
      roleId: superRoleId,
      features: [],
      organizations: [scenario.organizationId],
    })
    await queryDatabase('update role_acls set is_super_admin=true where role_id=$1', [superRoleId])
    const tenantSuperadmin = await createActor(request, scenario, superRoleId, 'identity-superadmin')

    const writeResponse = await scopedApiRequest(
      request,
      iod,
      'PUT',
      `/api/finoo_identities/people/${personId}`,
      identityInput,
    )
    expect(writeResponse.status()).toBe(200)
    expect(writeResponse.headers()['cache-control']).toBe('private, no-store')
    const writeBody = await writeResponse.json()
    expect(writeBody).toMatchObject({
      isComplete: true,
      statuses: {
        pesel: 'complete',
        documentType: 'complete',
        issuingCountryCode: 'complete',
        documentNumber: 'complete',
        issuedOn: 'complete',
        expiresOn: 'complete',
      },
    })
    expect(JSON.stringify(writeBody)).not.toContain(identityInput.pesel)
    expect(JSON.stringify(writeBody)).not.toContain(identityInput.documentNumber)

    const profileRows = await queryDatabase<{ id: string }>(
      `select id from customer_people
       where tenant_id=$1 and organization_id=$2 and entity_id=$3`,
      [scenario.tenantId, scenario.organizationId, personId],
    )
    expect(profileRows).toHaveLength(1)
    const profileId = profileRows[0]!.id
    const plaintextCanary = 'RETIRED_PLAINTEXT_CANARY'
    const ciphertextCanary = 'RETIRED_CIPHERTEXT_CANARY:v1'
    const aliasCanary = 'RETIRED_ALIAS_CANARY'
    await queryDatabase(
      `insert into custom_field_defs
         (id, entity_id, organization_id, tenant_id, key, kind, config_json, is_active, created_at, updated_at, deleted_at)
       values
         (gen_random_uuid(), 'customers:customer_person_profile', $1, $2, 'id_type', 'text', '{}', false, now(), now(), now()),
         (gen_random_uuid(), 'customers:customer_person_profile', $1, $2, 'id_number', 'text', '{"encrypted":true}', false, now(), now(), now())`,
      [scenario.organizationId, scenario.tenantId],
    )
    await queryDatabase(
      `insert into custom_field_values
         (id, entity_id, record_id, organization_id, tenant_id, field_key, value_text, created_at, deleted_at)
       values
         (gen_random_uuid(), 'customers:customer_person_profile', $1, $2, $3, 'id_type', $4, now(), null),
         (gen_random_uuid(), 'customers:customer_person_profile', $1, $2, $3, 'id_number', $5, now(), null),
         (gen_random_uuid(), 'customers:customer_person_profile', $1, $2, $3, 'cf_id_number', $6, now(), null)`,
      [profileId, scenario.organizationId, scenario.tenantId, plaintextCanary, ciphertextCanary, aliasCanary],
    )

    const ordinaryPersonResponse = await scopedApiRequest(
      request,
      ordinary,
      'GET',
      `/api/customers/people/${personId}`,
    )
    expect(ordinaryPersonResponse.status()).toBe(200)
    const ordinaryPersonBody = await ordinaryPersonResponse.json()
    expect(JSON.stringify(ordinaryPersonBody)).not.toContain(identityInput.pesel)
    expect(JSON.stringify(ordinaryPersonBody)).not.toContain(identityInput.documentNumber)
    expect(JSON.stringify(ordinaryPersonBody)).not.toContain(plaintextCanary)
    expect(JSON.stringify(ordinaryPersonBody)).not.toContain(ciphertextCanary)
    expect(JSON.stringify(ordinaryPersonBody)).not.toContain(aliasCanary)
    expect(JSON.stringify(ordinaryPersonBody)).not.toContain('cf_id_type')
    expect(JSON.stringify(ordinaryPersonBody)).not.toContain('cf_id_number')

    const standardCreateWithRetiredField = await scopedApiRequest(
      request,
      ordinaryManager,
      'POST',
      '/api/customers/people',
      {
        firstName: 'Rejected',
        lastName: 'Identity create',
        displayName: 'Rejected identity create',
        customFields: { id_number: 'CREATE_OVERWRITE_CANARY' },
      },
    )
    expect(standardCreateWithRetiredField.status()).toBe(400)
    const standardCreateWithPrefixedAlias = await scopedApiRequest(
      request,
      ordinaryManager,
      'POST',
      '/api/customers/people',
      {
        firstName: 'Rejected',
        lastName: 'Identity alias',
        displayName: 'Rejected identity alias',
        customFields: { cf_id_number: 'CREATE_ALIAS_CANARY' },
      },
    )
    expect(standardCreateWithPrefixedAlias.status()).toBe(400)
    const standardCreateWithDoublePrefix = await scopedApiRequest(
      request,
      ordinaryManager,
      'POST',
      '/api/customers/people',
      {
        firstName: 'Rejected',
        lastName: 'Identity double alias',
        displayName: 'Rejected identity double alias',
        customFields: { cf_cf_id_number: 'CREATE_DOUBLE_ALIAS_CANARY' },
      },
    )
    expect(standardCreateWithDoublePrefix.status()).toBe(400)

    const updatedAt = (ordinaryPersonBody as { person?: { updatedAt?: string } }).person?.updatedAt
    expect(updatedAt).toBeTruthy()
    const standardUpdateWithRetiredField = await apiRequest(request, 'PUT', '/api/customers/people', {
      token: ordinaryManager.token,
      headers: {
        Cookie: `om_selected_org=${ordinaryManager.organizationId}`,
        [OPTIMISTIC_LOCK_HEADER_NAME]: String(updatedAt),
      },
      data: {
        id: personId,
        customFields: { id_type: 'UPDATE_OVERWRITE_CANARY' },
      },
    })
    expect(standardUpdateWithRetiredField.status()).toBe(400)
    const historicalUndoToken = `finoo-history-${randomUUID()}`
    const historicalSnapshot = {
      entity: {
        id: personId,
        organizationId: scenario.organizationId,
        tenantId: scenario.tenantId,
        displayName: 'Identity Subject',
      },
      profile: { id: profileId },
      tagIds: [],
      custom: {
        id_type: plaintextCanary,
        id_number: ciphertextCanary,
      },
    }
    await queryDatabase(
      `insert into action_logs
         (id, tenant_id, organization_id, actor_user_id, command_id, action_label,
          resource_kind, resource_id, execution_state, undo_token, command_payload,
          snapshot_before, snapshot_after, changes_json, created_at, updated_at)
       values
         (gen_random_uuid(), $1, $2, $3, 'customers.people.update', 'Historical Person update',
          'customers.person', $4, 'done', $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb,
          now() + interval '1 minute', now() + interval '1 minute')`,
      [
        scenario.tenantId,
        scenario.organizationId,
        ordinaryManager.userId,
        personId,
        historicalUndoToken,
        JSON.stringify({
          undo: { before: historicalSnapshot, after: historicalSnapshot },
        }),
        JSON.stringify(historicalSnapshot),
        JSON.stringify(historicalSnapshot),
        JSON.stringify({
          'custom.id_type': { from: plaintextCanary, to: 'NEW_AUDIT_CANARY' },
        }),
      ],
    )

    const auditListResponse = await scopedApiRequest(
      request,
      ordinaryManager,
      'GET',
      `/api/audit_logs/audit-logs/actions?resourceId=${personId}`,
    )
    expect(auditListResponse.status()).toBe(200)
    const auditListText = JSON.stringify(await auditListResponse.json())
    expect(auditListText).not.toContain(plaintextCanary)
    expect(auditListText).not.toContain(ciphertextCanary)
    expect(auditListText).not.toContain('NEW_AUDIT_CANARY')

    const auditExportResponse = await scopedApiRequest(
      request,
      ordinaryManager,
      'GET',
      `/api/audit_logs/audit-logs/actions/export?resourceId=${personId}`,
    )
    expect(auditExportResponse.status()).toBe(200)
    const auditExportText = await auditExportResponse.text()
    expect(auditExportText).not.toContain(plaintextCanary)
    expect(auditExportText).not.toContain(ciphertextCanary)
    expect(auditExportText).not.toContain('NEW_AUDIT_CANARY')

    const undoHistoricalIdentity = await scopedApiRequest(
      request,
      ordinaryManager,
      'POST',
      '/api/audit_logs/audit-logs/actions/undo',
      { undoToken: historicalUndoToken },
    )
    expect(undoHistoricalIdentity.status()).toBe(400)
    const retainedLegacyValues = await queryDatabase<{
      field_key: string
      value_text: string | null
    }>(
      `select field_key, value_text from custom_field_values
       where tenant_id=$1 and organization_id=$2 and record_id=$3
         and field_key in ('id_type', 'id_number') and deleted_at is null
       order by field_key`,
      [scenario.tenantId, scenario.organizationId, profileId],
    )
    expect(retainedLegacyValues).toEqual([
      { field_key: 'id_number', value_text: ciphertextCanary },
      { field_key: 'id_type', value_text: plaintextCanary },
    ])

    const incompletePersonResponse = await scopedApiRequest(request, ordinaryManager, 'POST', '/api/customers/people', {
      firstName: 'Incomplete',
      lastName: 'Identity',
      displayName: 'Incomplete Identity',
    })
    expect(incompletePersonResponse.status()).toBe(201)
    const incompletePersonBody = (await incompletePersonResponse.json()) as {
      id?: string
    }
    expect(incompletePersonBody.id).toBeTruthy()

    const completeListResponse = await scopedApiRequest(
      request,
      ordinary,
      'GET',
      '/api/customers/people?finooIdentityComplete=true&pageSize=100',
    )
    expect(completeListResponse.status()).toBe(200)
    const completeListBody = (await completeListResponse.json()) as {
      items?: Array<{ id: string }>
    }
    expect(completeListBody.items?.map((item) => item.id)).toContain(personId)
    expect(completeListBody.items?.map((item) => item.id)).not.toContain(incompletePersonBody.id)

    const incompleteListResponse = await scopedApiRequest(
      request,
      ordinary,
      'GET',
      '/api/customers/people?finooIdentityComplete=false&pageSize=100',
    )
    expect(incompleteListResponse.status()).toBe(200)
    const incompleteListBody = (await incompleteListResponse.json()) as {
      items?: Array<{ id: string }>
    }
    expect(incompleteListBody.items?.map((item) => item.id)).toContain(incompletePersonBody.id)
    expect(incompleteListBody.items?.map((item) => item.id)).not.toContain(personId)

    const ordinaryStatusResponse = await scopedApiRequest(
      request,
      ordinary,
      'GET',
      `/api/finoo_identities/people/${personId}/status`,
    )
    expect(ordinaryStatusResponse.status()).toBe(200)
    expect(await ordinaryStatusResponse.json()).toEqual({
      isComplete: true,
      statuses: {
        pesel: 'complete',
        documentType: 'complete',
        issuingCountryCode: 'complete',
        documentNumber: 'complete',
        issuedOn: 'complete',
        expiresOn: 'complete',
      },
    })

    const ordinaryRawRead = await scopedApiRequest(
      request,
      ordinary,
      'GET',
      `/api/finoo_identities/people/${personId}`,
    )
    expect(ordinaryRawRead.status()).toBe(403)
    expect(await ordinaryRawRead.json()).toEqual({ error: 'identity_access_denied',
    })
    const ordinaryRawWrite = await scopedApiRequest(
      request,
      ordinary,
      'PUT',
      `/api/finoo_identities/people/${personId}`,
      identityInput,
    )
    expect(ordinaryRawWrite.status()).toBe(403)
    expect(await ordinaryRawWrite.json()).toEqual({ error: 'identity_access_denied',
    })

    for (const actor of [iod, tenantSuperadmin]) {
      const rawRead = await scopedApiRequest(
        request,
        actor,
        'GET',
        `/api/finoo_identities/people/${personId}`,
      )
      expect(rawRead.status()).toBe(200)
      expect(rawRead.headers()['cache-control']).toBe('private, no-store')
      expect(await rawRead.json()).toMatchObject(identityInput)
    }

    const stored = await queryDatabase<{
      pesel: string
      document_number: string
      is_complete: boolean
    }>(
      `select pesel, document_number, is_complete
       from finoo_person_identities
       where tenant_id=$1 and organization_id=$2 and person_id=$3 and deleted_at is null`,
      [scenario.tenantId, scenario.organizationId, personId],
    )
    expect(stored).toHaveLength(1)
    expect(stored[0]!.is_complete).toBe(true)
    expect(stored[0]!.pesel).not.toBe(identityInput.pesel)
    expect(stored[0]!.document_number).not.toBe(identityInput.documentNumber)
    expect(stored[0]!.pesel).toMatch(/:v1$/)
    expect(stored[0]!.document_number).toMatch(/:v1$/)

    const auditRows = await queryDatabase<{
      operation: string
      outcome: string
      changed_fields: string[] | null
    }>(
      `select operation, outcome, changed_fields
       from finoo_identity_audit_entries
       where tenant_id=$1 and organization_id=$2 and person_id=$3
       order by created_at asc`,
      [scenario.tenantId, scenario.organizationId, personId],
    )
    expect(auditRows).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: 'create', outcome: 'allowed' }),
      expect.objectContaining({ operation: 'read', outcome: 'allowed' }),
      expect.objectContaining({ operation: 'read', outcome: 'denied' }),
      expect.objectContaining({ operation: 'update', outcome: 'denied' }),
    ]))
    expect(JSON.stringify(auditRows)).not.toContain(identityInput.pesel)
    expect(JSON.stringify(auditRows)).not.toContain(identityInput.documentNumber)
  } finally {
    if (scenario) {
      const values = [scenario.tenantId, scenario.organizationId]
      await queryDatabase('delete from finoo_identity_import_conflicts where tenant_id=$1 and organization_id=$2', values)
      await queryDatabase('delete from finoo_identity_audit_entries where tenant_id=$1 and organization_id=$2', values)
      await queryDatabase('delete from finoo_person_identities where tenant_id=$1 and organization_id=$2', values)
      await queryDatabase(
        `delete from action_logs
         where tenant_id=$1 and organization_id=$2 and action_label='Historical Person update'`,
        values,
      )
      await queryDatabase(
        `delete from custom_field_values
         where tenant_id=$1 and organization_id=$2
           and field_key in ('id_type', 'id_number', 'cf_id_number')`,
        values,
      )
      await queryDatabase(
        `delete from custom_field_defs
         where tenant_id=$1 and organization_id=$2
           and entity_id='customers:customer_person_profile'
           and key in ('id_type', 'id_number')`,
        values,
      )
    }
    await cleanupScenario(request, scenario)
  }
})
