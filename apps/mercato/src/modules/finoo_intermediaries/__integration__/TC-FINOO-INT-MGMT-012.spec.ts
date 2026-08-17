import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { expect, test } from '@playwright/test'
import {
  cleanupScenario,
  createCustomerUser,
  createScenario,
  listDirectory,
  queryDatabase,
  scopedApiRequest,
  type Scenario,
} from './helpers'

const execFileAsync = promisify(execFile)

async function runBackfill(scenario: Scenario, mode: '--dry-run' | '--apply') {
  return execFileAsync('corepack', [
    'yarn', 'mercato', 'finoo_intermediaries', 'backfill-directory',
    '--tenant', scenario.tenantId,
    '--organization', scenario.organizationId,
    mode,
  ], { env: process.env, cwd: process.cwd() })
}

test('TC-FINOO-INT-MGMT-012 backfill dry-run, apply, encryption, and second no-op', async ({ request }) => {
  test.setTimeout(60_000)
  let scenario: Scenario | null = null
  try {
    scenario = await createScenario(request, 'TC-FINOO-INT-MGMT-012')
    const fallbackUser = await createCustomerUser(request, scenario, {
      displayName: 'Katherine Johnson',
      roleIds: [scenario.intermediaryRoleId],
    })
    const crmUser = await createCustomerUser(request, scenario, {
      email: `crm-${scenario.recipient}`,
      displayName: 'Display Name Ignored',
      roleIds: [scenario.intermediaryRoleId],
    })
    const personResponse = await scopedApiRequest(request, scenario, 'POST', '/api/customers/people', {
      firstName: 'CRM', lastName: 'Preferred', displayName: 'CRM Preferred',
      primaryEmail: crmUser.email,
    })
    expect(personResponse.status()).toBe(201)
    const personBody = (await personResponse.json()) as { id?: string; entityId?: string }
    const personId = personBody.id ?? personBody.entityId
    expect(personId).toBeTruthy()
    await queryDatabase('update customer_users set person_entity_id=$2 where id=$1', [crmUser.id, personId])
    const before = await queryDatabase<{ id: string; password_hash: string; is_active: boolean }>(
      'select id,password_hash,is_active from customer_users where id=any($1::uuid[]) order by id',
      [[fallbackUser.id, crmUser.id]],
    )
    const dry = await runBackfill(scenario, '--dry-run')
    expect(dry.stdout).toContain('dry-run')
    expect((await queryDatabase<{ count: string }>('select count(*)::text count from finoo_intermediaries where customer_user_id=any($1::uuid[])', [[fallbackUser.id, crmUser.id]]))[0]?.count).toBe('0')
    const applied = await runBackfill(scenario, '--apply')
    expect(applied.stdout).toContain('created')
    const stored = await queryDatabase<{ first_name: string; last_name: string; lifecycle_state: string }>('select first_name,last_name,lifecycle_state from finoo_intermediaries where customer_user_id=any($1::uuid[])', [[fallbackUser.id, crmUser.id]])
    expect(stored).toHaveLength(2)
    expect(stored.every((row) => row.lifecycle_state === 'active')).toBeTruthy()
    expect(stored.map((row) => row.first_name)).not.toContain('Katherine')
    const directory = await listDirectory(request, scenario)
    expect(directory.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ firstName: 'Katherine', lastName: 'Johnson' }),
      expect.objectContaining({ firstName: 'CRM', lastName: 'Preferred' }),
    ]))
    const second = await runBackfill(scenario, '--apply')
    expect(second.stdout).toMatch(/"created"\s*:\s*0/)
    expect(await queryDatabase('select id,password_hash,is_active from customer_users where id=any($1::uuid[]) order by id', [[fallbackUser.id, crmUser.id]])).toEqual(before)
  } finally {
    await cleanupScenario(request, scenario)
  }
})
