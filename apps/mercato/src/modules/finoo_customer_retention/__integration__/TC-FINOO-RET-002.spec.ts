import path from 'node:path'
import { expect, test, type APIRequestContext } from '@playwright/test'
import { apiRequest } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, createPersonFixture, readJsonSafe } from '@open-mercato/core/helpers/integration/crmFixtures'
import { drainIntegrationQueue } from '@open-mercato/core/helpers/integration/queue'
import { createQueue } from '@open-mercato/queue'
import { OPTIMISTIC_LOCK_HEADER_NAME } from '@open-mercato/shared/lib/crud/optimistic-lock-headers'
import {
  cleanupScenario, createScenario, queryDatabase, scopedApiRequest, type Scenario,
} from '../../finoo_intermediaries/__integration__/helpers'

export const integrationMeta = {
  dependsOnModules: ['finoo_customer_retention', 'finoo_intermediaries', 'finoo_affiliates', 'finoo_applications'],
}
const FEATURES = [
  'finoo_intermediaries.view', 'finoo_intermediaries.manage', 'customer_accounts.view',
  'customer_accounts.manage', 'customer_accounts.roles.manage', 'customer_accounts.invite',
  'communication_channels.connect_user_channel', 'customers.deals.view', 'customers.deals.manage',
  'customers.pipelines.manage', 'customers.companies.manage', 'customers.people.view',
  'customers.people.manage', 'customers.settings.manage', 'customers.activities.view',
  'customers.activities.manage', 'customers.interactions.view', 'customers.interactions.manage',
  'entities.definitions.manage',
]
const APP_ROOT = path.resolve(process.env.OM_TEST_APP_ROOT?.trim() || path.resolve(process.cwd(), 'apps/mercato'))
const retentionQueue = createQueue<{
  tenantId: string
  organizationId: string
  customerEntityId: string
}>('finoo-customer-retention-reconcile', 'local', {
  baseDir: path.resolve(APP_ROOT, '.mercato/queue'),
  concurrency: 1,
})

async function enqueuePerson(scenario: Scenario, personId: string): Promise<void> {
  await retentionQueue.enqueue({ tenantId: scenario.tenantId, organizationId: scenario.organizationId, customerEntityId: personId })
}

async function status(personId: string): Promise<{ retention_status: string; last_qualifying_activity_at: string | null } | null> {
  return (await queryDatabase<{ retention_status: string; last_qualifying_activity_at: string | null }>(
    'select retention_status,last_qualifying_activity_at from finoo_customer_retention_states where customer_entity_id=$1', [personId],
  ))[0] ?? null
}

async function cleanup(request: APIRequestContext, scenario: Scenario | null): Promise<void> {
  if (scenario) {
    await queryDatabase('delete from progress_jobs where tenant_id=$1 and organization_id=$2', [scenario.tenantId, scenario.organizationId])
    await queryDatabase('delete from custom_field_values where tenant_id=$1 and organization_id=$2', [scenario.tenantId, scenario.organizationId])
    await queryDatabase('delete from finoo_affiliates where tenant_id=$1 and organization_id=$2', [scenario.tenantId, scenario.organizationId])
    await queryDatabase('delete from finoo_customer_retention_states where tenant_id=$1 and organization_id=$2', [scenario.tenantId, scenario.organizationId])
    await queryDatabase('delete from finoo_customer_retention_settings where tenant_id=$1 and organization_id=$2', [scenario.tenantId, scenario.organizationId])
    await queryDatabase('delete from finoo_application_projections where tenant_id=$1 and organization_id=$2', [scenario.tenantId, scenario.organizationId])
    await queryDatabase('delete from customer_interactions where tenant_id=$1 and organization_id=$2', [scenario.tenantId, scenario.organizationId])
  }
  await cleanupScenario(request, scenario)
}

test('TC-FINOO-RET-002 qualifying activity reactivates and deletion recomputes through queues', async ({ request }) => {
  let scenario: Scenario | null = null
  try {
    scenario = await createScenario(request, 'TC-FINOO-RET-002', FEATURES)
    await queryDatabase(
      `insert into finoo_customer_retention_settings
       (id,tenant_id,organization_id,inactivity_window_days,reconciliation_generation,created_at,updated_at)
       values(gen_random_uuid(),$1,$2,1,1,now(),now())
       on conflict (tenant_id,organization_id) do update
       set inactivity_window_days=1,reconciliation_generation=1,updated_at=now()`, [scenario.tenantId, scenario.organizationId],
    )
    const personId = await createPersonFixture(request, scenario.token, {
      firstName: 'Activity', lastName: 'Person', displayName: 'TC-FINOO-RET-002 activity person',
    })
    const importedPersonId = await createPersonFixture(request, scenario.token, {
      firstName: 'Imported', lastName: 'Person', displayName: 'TC-FINOO-RET-002 imported person',
    })
    const companyId = await createCompanyFixture(request, scenario.token, 'TC-FINOO-RET-002 application company')
    const applicantPersonId = await createPersonFixture(request, scenario.token, {
      firstName: 'Application', lastName: 'Applicant', displayName: 'TC-FINOO-RET-002 application applicant',
      companyEntityId: companyId,
    })
    const representativePersonIds = await Promise.all([
      createPersonFixture(request, scenario.token, {
        firstName: 'First', lastName: 'Representative', displayName: 'TC-FINOO-RET-002 first representative',
        companyEntityId: companyId,
      }),
      createPersonFixture(request, scenario.token, {
        firstName: 'Second', lastName: 'Representative', displayName: 'TC-FINOO-RET-002 second representative',
        companyEntityId: companyId,
      }),
    ])
    const projectionId = (await queryDatabase<{ id: string }>(
      `insert into finoo_application_projections
       (id,tenant_id,organization_id,external_lead_id,state,company_entity_id,applicant_entity_id,
        warnings_json,submission_history_json,created_at,updated_at)
       values(gen_random_uuid(),$1,$2,$3,'completed',$4,$5,'[]'::jsonb,'[]'::jsonb,now(),now())
       returning id`,
      [scenario.tenantId, scenario.organizationId, `TC-FINOO-RET-002-${scenario.organizationId}`, companyId, applicantPersonId],
    ))[0]!.id
    const applicationPersonIds = [applicantPersonId, ...representativePersonIds]
    await queryDatabase(
      `update customer_entities
       set created_at=now()-interval '2 days',
           source=case
             when id=$2 then 'import'
             when id=any($3::uuid[]) then $4
             else source
           end
       where id=any($1::uuid[])`,
      [[personId, importedPersonId, ...applicationPersonIds], importedPersonId, applicationPersonIds, `finoo_application:${projectionId}`],
    )
    await queryDatabase(
      'delete from finoo_customer_retention_states where customer_entity_id=any($1::uuid[])',
      [[personId, importedPersonId, ...applicationPersonIds, companyId]],
    )
    for (const customerEntityId of [personId, importedPersonId, ...applicationPersonIds, companyId]) {
      await enqueuePerson(scenario, customerEntityId)
    }
    await drainIntegrationQueue('finoo-customer-retention-reconcile')
    for (const customerEntityId of [personId, importedPersonId, ...applicationPersonIds]) {
      await expect.poll(async () => (await status(customerEntityId))?.retention_status).toBe('expired')
    }
    expect(await status(companyId)).toBeNull()

    const initialPersonResponse = await scopedApiRequest(
      request,
      scenario,
      'GET',
      `/api/customers/people?id=${personId}`,
    )
    const initialPersonBody = await readJsonSafe<{
      items?: Array<{ updatedAt?: string; updated_at?: string }>
    }>(initialPersonResponse)
    const personUpdatedAt = initialPersonBody?.items?.[0]?.updatedAt
      ?? initialPersonBody?.items?.[0]?.updated_at
    expect(personUpdatedAt).toBeTruthy()
    const forgedMirror = await apiRequest(request, 'PUT', '/api/customers/people', {
      token: scenario.token,
      headers: {
        Cookie: `om_selected_org=${scenario.organizationId}`,
        [OPTIMISTIC_LOCK_HEADER_NAME]: String(personUpdatedAt),
      },
      data: {
        id: personId,
        customFields: { finoo_retention_status: 'active' },
      },
    })
    expect(forgedMirror.ok()).toBe(false)
    const retentionMirror = await queryDatabase<{ value_text: string | null }>(
      `select custom_field_values.value_text
       from custom_field_values
       join customer_people
         on customer_people.id::text=custom_field_values.record_id
       where customer_people.entity_id=$1
         and custom_field_values.field_key='finoo_retention_status'
         and custom_field_values.deleted_at is null`,
      [personId],
    )
    expect(retentionMirror[0]?.value_text).toBe('expired')

    const commentResponse = await apiRequest(request, 'POST', '/api/customers/comments', {
      token: scenario.token,
      data: { entityId: personId, body: 'TC-FINOO-RET-002 qualifying note' },
    })
    expect(commentResponse.status()).toBe(201)
    const comment = (await readJsonSafe<Record<string, unknown>>(commentResponse))!
    const commentId = String(comment.id)
    await drainIntegrationQueue('events')
    await drainIntegrationQueue('finoo-customer-retention-reconcile')
    await expect.poll(async () => (await status(personId))?.retention_status).toBe('active')
    const activeAfterComment = (await status(personId))!
    expect(activeAfterComment.retention_status).toBe('active')
    expect(activeAfterComment.last_qualifying_activity_at).toBeTruthy()

    await apiRequest(request, 'DELETE', `/api/customers/comments?id=${encodeURIComponent(commentId)}`, { token: scenario.token })
    await drainIntegrationQueue('events')
    await drainIntegrationQueue('finoo-customer-retention-reconcile')
    await expect.poll(async () => (await status(personId))?.retention_status).toBe('expired')

    const interactionResponse = await apiRequest(request, 'POST', '/api/customers/interactions', {
      token: scenario.token,
      data: {
        entityId: personId, interactionType: 'task', title: 'TC-FINOO-RET-002 planned task', status: 'planned',
        scheduledAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    })
    expect(interactionResponse.status()).toBe(201)
    const interaction = (await readJsonSafe<Record<string, unknown>>(interactionResponse))!
    const interactionId = String(interaction.id)
    await drainIntegrationQueue('events')
    await drainIntegrationQueue('finoo-customer-retention-reconcile')
    await expect.poll(async () => (await status(personId))?.retention_status).toBe('active')
    const createdTaskActivityAt = (await status(personId))!.last_qualifying_activity_at!

    const interactionVersion = (await queryDatabase<{ updated_at: string }>(
      'select updated_at from customer_interactions where id=$1', [interactionId],
    ))[0]!.updated_at
    const edited = await apiRequest(request, 'PUT', '/api/customers/interactions', {
      token: scenario.token,
      headers: {
        Cookie: `om_selected_org=${scenario.organizationId}`,
        [OPTIMISTIC_LOCK_HEADER_NAME]: new Date(interactionVersion).toISOString(),
      },
      data: { id: interactionId, title: 'TC-FINOO-RET-002 edited task title' },
    })
    expect(edited.ok()).toBe(true)
    await drainIntegrationQueue('events')
    await drainIntegrationQueue('finoo-customer-retention-reconcile')
    expect(new Date((await status(personId))!.last_qualifying_activity_at!).getTime()).toBe(
      new Date(createdTaskActivityAt).getTime(),
    )

    const completed = await apiRequest(request, 'POST', '/api/customers/interactions/complete', {
      token: scenario.token, data: { id: interactionId },
    })
    expect(completed.ok()).toBe(true)
    await drainIntegrationQueue('events')
    await drainIntegrationQueue('finoo-customer-retention-reconcile')
    const completedTaskState = (await status(personId))!
    expect(completedTaskState.retention_status).toBe('active')
    expect(new Date(completedTaskState.last_qualifying_activity_at!).getTime()).toBeGreaterThan(
      new Date(createdTaskActivityAt).getTime(),
    )

    await apiRequest(request, 'DELETE', `/api/customers/interactions?id=${encodeURIComponent(interactionId)}`, { token: scenario.token })
    await drainIntegrationQueue('events')
    await drainIntegrationQueue('finoo-customer-retention-reconcile')
    await expect.poll(async () => (await status(personId))?.retention_status).toBe('expired')

    const cancelTaskResponse = await apiRequest(request, 'POST', '/api/customers/interactions', {
      token: scenario.token,
      data: {
        entityId: personId, interactionType: 'task', title: 'TC-FINOO-RET-002 cancel task', status: 'planned',
        scheduledAt: new Date(Date.now() + 172_800_000).toISOString(),
      },
    })
    expect(cancelTaskResponse.status()).toBe(201)
    const cancelTask = (await readJsonSafe<Record<string, unknown>>(cancelTaskResponse))!
    const cancelTaskId = String(cancelTask.id)
    await drainIntegrationQueue('events')
    await drainIntegrationQueue('finoo-customer-retention-reconcile')
    await expect.poll(async () => (await status(personId))?.retention_status).toBe('active')
    const canceled = await apiRequest(request, 'POST', '/api/customers/interactions/cancel', {
      token: scenario.token, data: { id: cancelTaskId },
    })
    expect(canceled.ok()).toBe(true)
    await drainIntegrationQueue('events')
    await drainIntegrationQueue('finoo-customer-retention-reconcile')
    await expect.poll(async () => (await status(personId))?.retention_status).toBe('expired')

    const listed = await scopedApiRequest(request, scenario, 'GET', `/api/customers/people?id=${personId}`)
    expect(listed.status()).toBe(200)
  } finally {
    await cleanup(request, scenario)
  }
})
