import {
  redactCustomFieldKeysFromActionLog,
  redactInactiveCustomFieldsFromActionLogs,
} from '../customFieldRedaction'

describe('audit-log inactive custom-field redaction', () => {
  it('removes tombstoned Person values from snapshots, changes, and array payloads', async () => {
    const em = {
      find: jest.fn(async () => [
        {
          entityId: 'customers:customer_person_profile',
          key: 'id_number',
          tenantId: 'tenant-1',
          organizationId: 'org-1',
          isActive: false,
          deletedAt: new Date('2026-08-24T00:00:00.000Z'),
          updatedAt: new Date('2026-08-24T00:00:00.000Z'),
        },
      ]),
    }
    const [entry] = await redactInactiveCustomFieldsFromActionLogs(em as never, [
      {
        resourceKind: 'customers.person',
        tenantId: 'tenant-1',
        organizationId: 'org-1',
        commandPayload: { customFields: { id_number: 'COMMAND_CANARY', harmless: 'visible' } },
        snapshotBefore: {
          custom: { id_number: 'DOCUMENT_CANARY', harmless: 'visible' },
          customFields: [
            { key: 'id_number', value: 'ARRAY_CANARY' },
            { key: 'harmless', value: 'visible' },
          ],
        },
        snapshotAfter: { custom: { cf_id_number: 'PREFIXED_CANARY' } },
        changesJson: {
          'custom.id_number': { from: 'OLD_CANARY', to: 'NEW_CANARY' },
          displayName: { to: 'Ada' },
        },
        contextJson: null,
      },
    ])

    expect(entry.snapshotBefore).toEqual({
      custom: { harmless: 'visible' },
      customFields: [{ key: 'harmless', value: 'visible' }],
    })
    expect(entry.commandPayload).toEqual({ customFields: { harmless: 'visible' } })
    expect(entry.snapshotAfter).toEqual({ custom: {} })
    expect(entry.changesJson).toEqual({ displayName: { to: 'Ada' } })
    expect(JSON.stringify(entry)).not.toContain('CANARY')
  })

  it('can permanently scrub protected keys without relying on live definitions', () => {
    const entry = redactCustomFieldKeysFromActionLog(
      {
        resourceKind: 'customers.person',
        commandPayload: { customFields: { cf_id_number: 'COMMAND_CANARY' } },
        snapshotBefore: { custom: { id_number: 'SNAPSHOT_CANARY', nickname: 'Ada' } },
      },
      new Set(['id_number']),
    )

    expect(entry.commandPayload).toEqual({ customFields: {} })
    expect(entry.snapshotBefore).toEqual({ custom: { nickname: 'Ada' } })
    expect(JSON.stringify(entry)).not.toContain('CANARY')
  })

  it('lets an exact inactive definition override a generic active definition', async () => {
    const em = {
      find: jest.fn(async () => [
        {
          entityId: 'customers:customer_person_profile',
          key: 'id_number',
          tenantId: null,
          organizationId: null,
          isActive: true,
          deletedAt: null,
          updatedAt: new Date('2026-08-20T00:00:00.000Z'),
        },
        {
          entityId: 'customers:customer_person_profile',
          key: 'id_number',
          tenantId: 'tenant-1',
          organizationId: 'org-1',
          isActive: false,
          deletedAt: new Date('2026-08-24T00:00:00.000Z'),
          updatedAt: new Date('2026-08-24T00:00:00.000Z'),
        },
      ]),
    }
    const [entry] = await redactInactiveCustomFieldsFromActionLogs(em as never, [
      {
        resourceKind: 'customers.person',
        tenantId: 'tenant-1',
        organizationId: 'org-1',
        snapshotBefore: { custom: { id_number: 'DOCUMENT_CANARY' } },
      },
    ])

    expect(entry.snapshotBefore).toEqual({ custom: {} })
  })
})
