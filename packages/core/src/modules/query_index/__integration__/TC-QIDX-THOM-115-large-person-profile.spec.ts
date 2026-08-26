import { randomBytes, randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { withClient } from '@open-mercato/core/helpers/integration/dbFixtures'

test.describe('TC-QIDX-THOM-115: large person-profile projections', () => {
  test('stores large documents in organization and tenant scopes', async () => {
    const tenantId = randomUUID()
    const organizationId = randomUUID()
    const organizationRecordId = randomUUID()
    const tenantRecordId = randomUUID()
    const largeDocument = { payload: randomBytes(8192).toString('hex') }

    try {
      await withClient(async (client) => {
        const inserted = await client.query(
          `insert into entity_indexes
             (entity_type, entity_id, organization_id, tenant_id, doc, index_version, created_at, updated_at)
           values
             ('customers:customer_person_profile', $1, $2, $3, $4::jsonb, 1, now(), now()),
             ('customers:customer_person_profile', $5, null, $3, $4::jsonb, 1, now(), now())`,
          [organizationRecordId, organizationId, tenantId, JSON.stringify(largeDocument), tenantRecordId],
        )

        expect(inserted.rowCount).toBe(2)
      })
    } finally {
      await withClient(async (client) => {
        await client.query(
          `delete from entity_indexes
           where entity_type = 'customers:customer_person_profile'
             and tenant_id = $1
             and entity_id = any($2::text[])`,
          [tenantId, [organizationRecordId, tenantRecordId]],
        )
      }).catch(() => undefined)
    }
  })
})
