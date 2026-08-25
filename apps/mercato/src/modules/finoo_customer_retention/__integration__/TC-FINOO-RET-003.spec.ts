import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { expect, test, type APIRequestContext } from '@playwright/test'
import { createPersonFixture } from '@open-mercato/core/helpers/integration/crmFixtures'
import { apiRequest } from '@open-mercato/core/helpers/integration/api'
import { drainIntegrationQueue } from '@open-mercato/core/helpers/integration/queue'
import { expectOperation, undoOk } from '@open-mercato/core/helpers/integration/undoHarness'
import { createQueue } from '@open-mercato/queue'
import { bootstrapFromAppRoot } from '@open-mercato/shared/lib/bootstrap/dynamicLoader'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { FinooAffiliateRetentionEligibilityProvider } from '../../finoo_affiliates/lib/retentionEligibilityProvider'
import type { FinooIntermediaryRetentionEligibilityProvider } from '../../finoo_intermediaries/lib/retentionEligibilityProvider'
import type { FinooCustomerRetentionProjectionService } from '../services/projectionService'
import {
  cleanupScenario, createCustomerUser, createScenario, queryDatabase, type Scenario,
} from '../../finoo_intermediaries/__integration__/helpers'

export const integrationMeta = {
  dependsOnModules: ['finoo_customer_retention', 'finoo_intermediaries', 'finoo_affiliates'],
}
const FEATURES = [
  'finoo_intermediaries.view', 'finoo_intermediaries.manage', 'customer_accounts.view',
  'customer_accounts.manage', 'customer_accounts.roles.manage', 'customer_accounts.invite',
  'communication_channels.connect_user_channel', 'customers.deals.view', 'customers.deals.manage',
  'customers.pipelines.manage', 'customers.companies.manage', 'customers.people.view',
  'customers.people.manage', 'customers.settings.manage', 'entities.definitions.manage',
  'audit_logs.view_self', 'audit_logs.undo_self',
]
const APP_ROOT = path.resolve(process.env.OM_TEST_APP_ROOT?.trim() || path.resolve(process.cwd(), 'apps/mercato'))
const retentionQueue = createQueue<{
  tenantId: string
  organizationId: string
  customerEntityId: string
  eligibilityResetActionLogId?: string
}>('finoo-customer-retention-reconcile', 'local', {
  baseDir: path.resolve(APP_ROOT, '.mercato/queue'),
  concurrency: 1,
})

test.setTimeout(60_000)

async function reconcile(
  scenario: Scenario,
  personId: string,
  expectedStatus: 'active' | 'expired' | 'excluded',
): Promise<void> {
  await retentionQueue.enqueue({ tenantId: scenario.tenantId, organizationId: scenario.organizationId, customerEntityId: personId })
  await drainIntegrationQueue('finoo-customer-retention-reconcile')
  await expect.poll(async () => (await queryDatabase<{ count: string }>(
    'select count(*)::text count from finoo_customer_retention_states where customer_entity_id=$1', [personId],
  ))[0]?.count).toBe('1')
  await expect.poll(async () => (await state(personId)).retention_status).toBe(expectedStatus)
}

async function state(personId: string) {
  return (await queryDatabase<{ retention_status: string; eligibility_anchor_at: string; retention_expires_at: string | null }>(
    'select retention_status,eligibility_anchor_at,retention_expires_at from finoo_customer_retention_states where customer_entity_id=$1', [personId],
  ))[0]!
}

async function retentionStatusMirror(personId: string): Promise<string | null> {
  return (await queryDatabase<{ value_text: string | null }>(
    `select custom_field_values.value_text
     from custom_field_values
     join customer_people on customer_people.id::text=custom_field_values.record_id
     where customer_people.entity_id=$1
       and custom_field_values.field_key='finoo_retention_status'
       and custom_field_values.deleted_at is null`,
    [personId],
  ))[0]?.value_text ?? null
}

async function partnerFacts(scenario: Scenario, customerUserId: string) {
  await bootstrapFromAppRoot(APP_ROOT)
  const container = await createRequestContainer()
  try {
    const input = {
      tenantId: scenario.tenantId,
      organizationId: scenario.organizationId,
      customerUserIds: [customerUserId],
    }
    return {
      affiliate: await container.resolve<FinooAffiliateRetentionEligibilityProvider>(
        'finooAffiliateRetentionEligibilityProvider',
      ).findFacts(input),
      intermediary: await container.resolve<FinooIntermediaryRetentionEligibilityProvider>(
        'finooIntermediaryRetentionEligibilityProvider',
      ).findFacts(input),
    }
  } finally {
    await container.dispose()
  }
}

async function hourlyReconcile(scenario: Scenario): Promise<void> {
  await bootstrapFromAppRoot(APP_ROOT)
  const container = await createRequestContainer()
  try {
    const projection = container.resolve<FinooCustomerRetentionProjectionService>(
      'finooCustomerRetentionProjectionService',
    )
    let afterCustomerEntityId: string | undefined
    do {
      const page = await projection.reconcilePage({
        tenantId: scenario.tenantId,
        organizationId: scenario.organizationId,
        afterCustomerEntityId,
      })
      afterCustomerEntityId = page.nextCustomerEntityId ?? undefined
    } while (afterCustomerEntityId)
  } finally {
    await container.dispose()
  }
}

async function cleanup(request: APIRequestContext, scenario: Scenario | null): Promise<void> {
  if (scenario) {
    await queryDatabase('delete from progress_jobs where tenant_id=$1 and organization_id=$2', [scenario.tenantId, scenario.organizationId])
    await queryDatabase('delete from custom_field_values where tenant_id=$1 and organization_id=$2', [scenario.tenantId, scenario.organizationId])
    await queryDatabase('delete from finoo_affiliates where tenant_id=$1 and organization_id=$2', [scenario.tenantId, scenario.organizationId])
    await queryDatabase('delete from finoo_customer_retention_states where tenant_id=$1 and organization_id=$2', [scenario.tenantId, scenario.organizationId])
    await queryDatabase('delete from finoo_customer_retention_settings where tenant_id=$1 and organization_id=$2', [scenario.tenantId, scenario.organizationId])
  }
  await cleanupScenario(request, scenario)
}

test('TC-FINOO-RET-003 affiliate and intermediary exclusion, dual-link re-entry, and scope isolation', async ({ request }) => {
  let scenario: Scenario | null = null
  let foreignScenario: Scenario | null = null
  try {
    scenario = await createScenario(request, 'TC-FINOO-RET-003', FEATURES)
    foreignScenario = await createScenario(request, 'TC-FINOO-RET-003-FOREIGN', FEATURES)
    for (const current of [scenario, foreignScenario]) {
      await queryDatabase(
        `insert into finoo_customer_retention_settings
         (id,tenant_id,organization_id,inactivity_window_days,reconciliation_generation,created_at,updated_at)
         values(gen_random_uuid(),$1,$2,30,1,now(),now())
         on conflict (tenant_id,organization_id) do update
         set inactivity_window_days=30,reconciliation_generation=1,updated_at=now()`, [current.tenantId, current.organizationId],
      )
    }

    const personId = await createPersonFixture(request, scenario.token, {
      firstName: 'Partner', lastName: 'Excluded', displayName: 'TC-FINOO-RET-003 excluded person',
    })
    const customerUser = await createCustomerUser(request, scenario, {
      email: `retention-${scenario.recipient}`, displayName: 'Retention partner',
    })
    await queryDatabase('update customer_users set person_entity_id=$2 where id=$1', [customerUser.id, personId])
    await queryDatabase(
      `insert into customer_users
       (id,tenant_id,organization_id,email,email_hash,display_name,person_entity_id,is_active,created_at,updated_at,deleted_at)
       select gen_random_uuid(),$1,$2,
         'bridge-' || bridge_index::text || '-' || $3 || '@test.local',
         'bridge-hash-' || bridge_index::text || '-' || $3,
         'Retention bridge ' || bridge_index::text,$4,false,now(),now(),now()
       from generate_series(1,100) bridge_index`,
      [scenario.tenantId, scenario.organizationId, customerUser.id, personId],
    )
    expect((await queryDatabase<{ count: string }>(
      'select count(*)::text count from customer_users where tenant_id=$1 and organization_id=$2 and person_entity_id=$3',
      [scenario.tenantId, scenario.organizationId, personId],
    ))[0]?.count).toBe('101')

    const affiliateId = randomUUID()
    const intermediaryId = randomUUID()
    const code = randomUUID().replace(/-/g, '').slice(0, 24).toUpperCase()
    await queryDatabase(
      `insert into finoo_affiliates
       (id,organization_id,tenant_id,customer_user_id,email,email_hash,code,is_active,created_at,updated_at)
       values($1,$2,$3,$4,$5,$6,$7,true,now(),now())`,
      [affiliateId, scenario.organizationId, scenario.tenantId, customerUser.id, customerUser.email, `hash-${affiliateId}`, code],
    )
    await queryDatabase(
      `insert into finoo_intermediaries
       (id,tenant_id,organization_id,first_name,last_name,email,email_hash,lifecycle_state,customer_user_id,created_at,updated_at)
       values($1,$2,$3,'Partner','Excluded',$4,$5,'active',$6,now(),now())`,
      [intermediaryId, scenario.tenantId, scenario.organizationId, customerUser.email, `hash-${intermediaryId}`, customerUser.id],
    )
    await queryDatabase(
      'update customer_users set deleted_at=now(),is_active=false,updated_at=now() where id=$1',
      [customerUser.id],
    )

    await reconcile(scenario, personId, 'excluded')
    expect(await state(personId)).toMatchObject({ retention_status: 'excluded', retention_expires_at: null })
    const initiallyExcluded = await partnerFacts(scenario, customerUser.id)
    expect(initiallyExcluded.affiliate.activeCustomerUserIds).toEqual([customerUser.id])
    expect(initiallyExcluded.intermediary.activeCustomerUserIds).toEqual([customerUser.id])

    const affiliateDeletedAt = new Date(Date.now() - 2_000).toISOString()
    await queryDatabase('update finoo_affiliates set deleted_at=$2,updated_at=now() where id=$1', [affiliateId, affiliateDeletedAt])
    const affiliateRemoved = await partnerFacts(scenario, customerUser.id)
    expect(affiliateRemoved.affiliate.activeCustomerUserIds).toEqual([])
    expect(affiliateRemoved.intermediary.activeCustomerUserIds).toEqual([customerUser.id])
    await reconcile(scenario, personId, 'excluded')
    expect((await state(personId)).retention_status).toBe('excluded')

    const intermediaryDeletedAt = new Date().toISOString()
    await queryDatabase('update finoo_intermediaries set deleted_at=$2,updated_at=now() where id=$1', [intermediaryId, intermediaryDeletedAt])
    const allPartnerRolesRemoved = await partnerFacts(scenario, customerUser.id)
    expect(allPartnerRolesRemoved.affiliate.activeCustomerUserIds).toEqual([])
    expect(allPartnerRolesRemoved.intermediary.activeCustomerUserIds).toEqual([])
    await reconcile(scenario, personId, 'active')
    const reentered = await state(personId)
    expect(reentered.retention_status).toBe('active')
    expect(new Date(reentered.eligibility_anchor_at).getTime()).toBeGreaterThanOrEqual(new Date(affiliateDeletedAt).getTime())

    const collapsedPartnerPersonId = await createPersonFixture(request, scenario.token, {
      firstName: 'Collapsed', lastName: 'Partner', displayName: 'TC-FINOO-RET-003 collapsed partner transition',
    })
    await reconcile(scenario, collapsedPartnerPersonId, 'active')
    const collapsedPartnerOldAnchor = new Date((await state(collapsedPartnerPersonId)).eligibility_anchor_at)
    const collapsedPartnerUser = await createCustomerUser(request, scenario, {
      email: `collapsed-${scenario.recipient}`, displayName: 'Collapsed retention partner',
    })
    await queryDatabase('update customer_users set person_entity_id=$2 where id=$1', [collapsedPartnerUser.id, collapsedPartnerPersonId])
    const collapsedAffiliateId = randomUUID()
    const collapsedAffiliateCode = randomUUID().replace(/-/g, '').slice(0, 24).toUpperCase()
    await queryDatabase(
      `insert into finoo_affiliates
       (id,organization_id,tenant_id,customer_user_id,email,email_hash,code,is_active,created_at,updated_at)
       values($1,$2,$3,$4,$5,$6,$7,true,now(),now())`,
      [collapsedAffiliateId, scenario.organizationId, scenario.tenantId, collapsedPartnerUser.id, collapsedPartnerUser.email, `hash-${collapsedAffiliateId}`, collapsedAffiliateCode],
    )
    const collapsedPartnerDeletedAt = new Date().toISOString()
    await queryDatabase(
      'update finoo_affiliates set deleted_at=$2,updated_at=$2 where id=$1',
      [collapsedAffiliateId, collapsedPartnerDeletedAt],
    )
    await reconcile(scenario, collapsedPartnerPersonId, 'active')
    const collapsedPartnerNewAnchor = new Date((await state(collapsedPartnerPersonId)).eligibility_anchor_at)
    expect(collapsedPartnerNewAnchor.getTime()).toBeGreaterThan(collapsedPartnerOldAnchor.getTime())
    expect(collapsedPartnerNewAnchor.getTime()).toBeGreaterThanOrEqual(new Date(collapsedPartnerDeletedAt).getTime())

    const lifecyclePersonId = await createPersonFixture(request, scenario.token, {
      firstName: 'Lifecycle', lastName: 'Undo', displayName: 'TC-FINOO-RET-003 lifecycle person',
    })
    await reconcile(scenario, lifecyclePersonId, 'active')
    const updateResponse = await apiRequest(request, 'PUT', '/api/customers/people', {
      token: scenario.token,
      data: { id: lifecyclePersonId, displayName: 'TC-FINOO-RET-003 lifecycle updated' },
    })
    expect(updateResponse.ok()).toBe(true)
    const updateOperation = expectOperation(updateResponse, 'customers.people.update')
    await queryDatabase(
      `update finoo_customer_retention_states
       set eligibility_anchor_at=now()-interval '40 days',updated_at=now()
       where customer_entity_id=$1`,
      [lifecyclePersonId],
    )
    await reconcile(scenario, lifecyclePersonId, 'expired')
    expect(await retentionStatusMirror(lifecyclePersonId)).toBe('expired')

    await undoOk(request, scenario.token, updateOperation.undoToken, 'undo retention person update')
    expect(await retentionStatusMirror(lifecyclePersonId)).toBe('active')
    await drainIntegrationQueue('finoo-customer-retention-reconcile')
    await expect.poll(() => retentionStatusMirror(lifecyclePersonId)).toBe('expired')
    expect((await state(lifecyclePersonId)).retention_status).toBe('expired')

    await retentionQueue.enqueue({
      tenantId: scenario.tenantId,
      organizationId: scenario.organizationId,
      customerEntityId: lifecyclePersonId,
      eligibilityResetActionLogId: randomUUID(),
    })
    await drainIntegrationQueue('finoo-customer-retention-reconcile')
    expect((await state(lifecyclePersonId)).retention_status).toBe('expired')
    expect(await retentionStatusMirror(lifecyclePersonId)).toBe('expired')

    const deleteResponse = await apiRequest(
      request,
      'DELETE',
      `/api/customers/people?id=${lifecyclePersonId}`,
      { token: scenario.token },
    )
    expect(deleteResponse.ok()).toBe(true)
    const deleteOperation = expectOperation(deleteResponse, 'customers.people.delete')
    await undoOk(request, scenario.token, deleteOperation.undoToken, 'undo retention person delete')
    await hourlyReconcile(scenario)
    await expect.poll(async () => (await state(lifecyclePersonId)).retention_status).toBe('active')
    expect(await retentionStatusMirror(lifecyclePersonId)).toBe('active')
    await drainIntegrationQueue('finoo-customer-retention-reconcile')
    expect((await state(lifecyclePersonId)).retention_status).toBe('active')

    const undoneDelete = (await queryDatabase<{ id: string }>(
      `select id from action_logs
       where tenant_id=$1 and organization_id=$2 and command_id='customers.people.delete'
         and resource_kind='customers.person' and resource_id=$3 and execution_state='undone'
       order by updated_at desc limit 1`,
      [scenario.tenantId, scenario.organizationId, lifecyclePersonId],
    ))[0]
    expect(undoneDelete?.id).toBeTruthy()
    await queryDatabase(
      `with reset_time as (select now()-interval '40 days' value)
       update action_logs set updated_at=reset_time.value
       from reset_time where id=$1`,
      [undoneDelete!.id],
    )
    await queryDatabase(
      `update finoo_customer_retention_states
       set eligibility_anchor_at=(select updated_at from action_logs where id=$2),updated_at=now()
       where customer_entity_id=$1`,
      [lifecyclePersonId, undoneDelete!.id],
    )
    await reconcile(scenario, lifecyclePersonId, 'expired')
    expect(await retentionStatusMirror(lifecyclePersonId)).toBe('expired')

    const foreignPersonId = await createPersonFixture(request, foreignScenario.token, {
      firstName: 'Foreign', lastName: 'Scope', displayName: 'TC-FINOO-RET-003 foreign person',
    })
    await reconcile(foreignScenario, foreignPersonId, 'active')
    expect((await queryDatabase<{ count: string }>(
      'select count(*)::text count from finoo_customer_retention_states where tenant_id=$1 and organization_id=$2 and customer_entity_id=$3',
      [scenario.tenantId, scenario.organizationId, foreignPersonId],
    ))[0]?.count).toBe('0')
  } finally {
    await cleanup(request, foreignScenario)
    await cleanup(request, scenario)
  }
})
