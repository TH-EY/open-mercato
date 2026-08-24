import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type APIRequestContext } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
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

type Actor = Pick<Scenario, 'organizationId'> & { token: string }

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
  await createUserFixture(request, scenario.superToken, {
    email,
    password,
    organizationId: scenario.organizationId,
    roles: [roleId],
    name: `${label} actor`,
  })
  return {
    token: await getAuthToken(request, email, password),
    organizationId: scenario.organizationId,
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
    const personBody = (await personResponse.json()) as { id?: string; entityId?: string }
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
    expect(await ordinaryRawRead.json()).toEqual({ error: 'identity_access_denied' })
    const ordinaryRawWrite = await scopedApiRequest(
      request,
      ordinary,
      'PUT',
      `/api/finoo_identities/people/${personId}`,
      identityInput,
    )
    expect(ordinaryRawWrite.status()).toBe(403)
    expect(await ordinaryRawWrite.json()).toEqual({ error: 'identity_access_denied' })

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
    }
    await cleanupScenario(request, scenario)
  }
})
