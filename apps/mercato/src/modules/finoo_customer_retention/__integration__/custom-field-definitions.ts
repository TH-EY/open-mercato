import path from 'node:path'
import type { EntityManager } from '@mikro-orm/postgresql'
import { bootstrapFromAppRoot } from '@open-mercato/shared/lib/bootstrap/dynamicLoader'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { ensureFinooCustomerRetentionCustomFieldDefinitions } from '../lib/custom-field-definitions'
import { queryDatabase, type Scenario } from '../../finoo_intermediaries/__integration__/helpers'

const APP_ROOT = path.resolve(process.env.OM_TEST_APP_ROOT?.trim() || path.resolve(process.cwd(), 'apps/mercato'))

export async function installRetentionCustomFieldDefinitions(
  scenario: Pick<Scenario, 'tenantId'>,
): Promise<void> {
  await bootstrapFromAppRoot(APP_ROOT)
  const container = await createRequestContainer()
  try {
    const em = (container.resolve('em') as EntityManager).fork()
    await ensureFinooCustomerRetentionCustomFieldDefinitions({
      em,
      tenantId: scenario.tenantId,
    })
  } finally {
    await container.dispose()
  }
}

export async function cleanupRetentionCustomFieldDefinitions(
  scenario: Pick<Scenario, 'tenantId'>,
): Promise<void> {
  await queryDatabase(
    `delete from custom_field_defs
     where tenant_id=$1
       and organization_id is null
       and entity_id='customers:customer_person_profile'
       and key=any($2::text[])`,
    [scenario.tenantId, ['finoo_retention_status', 'finoo_retention_expires_at']],
  )
}
